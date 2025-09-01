import type { Config, Context } from '@netlify/functions';

import { getCacheEntry, isStale } from '../lib/cache.mjs';
import { enqueueRefresh } from '../lib/queue.mjs';
import type { CacheEntry } from '../lib/types.mjs';
import { poolRandom } from '../lib/pool.mjs';
import { json } from '../lib/server.mjs';

export const config: Config = {
  path: '/api/v1/cache/:source_id/:key',
  method: 'GET',
};

async function GET(req: Request, context: Context) {
  const url = new URL(req.url);
  const params = context.params || {};
  const source_id = (params['source_id'] as string) ?? url.searchParams.get('source_id') ?? undefined;
  const key = (params['key'] as string) ?? url.searchParams.get('key') ?? undefined;

  if (!source_id || !key) {
    return json({ error: 'source_id and key are required' }, 422);
  }

  const bypass = /^true|1$/i.test(req.headers.get('X-UC-Bypass-Cache') || '');
  const cacheOnly = /^true|1$/i.test(req.headers.get('X-UC-Cache-Only') || '');
  const ifNoneMatch = req.headers.get('If-None-Match');

  // Try a random return from the pool: if this key has pool data, prefer returning it
  try {
    const poolItem = await poolRandom(source_id, key);
    if (poolItem) {
      const headers: Record<string, string> = {
        'X-UC-Cache': bypass ? 'BYPASS' : 'HIT',
        'X-UC-Served-From': `pool-${poolItem.from}`,
      };
      const etag = poolItem.item_id;
      if (etag) headers['ETag'] = etag;
      // Return 304 when If-None-Match matches the item_id
      if (ifNoneMatch && etag && ifNoneMatch.split(/\s*,\s*/).includes(etag)) {
        return new Response(null, { status: 304, headers });
      }
      // BYPASS: backfill the pool in the background (enqueue a /pool: job)
      if (bypass) {
        const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const sep = key.includes('?') ? '&' : '?';
        enqueueRefresh({ source_id, key: `/pool:${key}${sep}i=${encodeURIComponent(nonce)}` }).catch(() => {});
      }
      return json(
        {
          data: poolItem.data,
          meta: {
            source_id,
            key,
            pool: true,
            item_id: poolItem.item_id,
            content_type: poolItem.content_type ?? null,
            data_encoding: poolItem.encoding,
            served_from: `pool-${poolItem.from}`,
          },
        },
        200,
        headers
      );
    }
  } catch {}

  // If the Source enables pool mode, do not fall back to the fixed cache.
  // Dynamic import to avoid throwing in test environments without DB config.
  try {
    const mod = await import('../lib/sources-pg.mjs');
    const supportsPool = await mod.getSourceSupportsPool(source_id);
    if (supportsPool) {
      if (cacheOnly) {
        return json({ error: 'Pool miss' }, 404, { 'X-UC-Cache': 'MISS', 'X-UC-Served-From': 'pool-none' });
      }
      const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const sep = key.includes('?') ? '&' : '?';
      const r = await enqueueRefresh({ source_id, key: `/pool:${key}${sep}i=${encodeURIComponent(nonce)}` });
      return json(
        { ok: true, endpoint: 'cache-get', enqueued: r.enqueued, task_id: r.jobId, source_id, key, pool: true },
        202,
        { 'X-UC-Cache': 'MISS', 'X-UC-Served-From': 'pool-none', 'X-UC-Task-Id': r.jobId ?? '' }
      );
    }
  } catch {}

  const entry: CacheEntry | null = await getCacheEntry(source_id, key);

  // helper to compute age seconds
  const ageSec = (cached_at?: string): string | undefined => {
    if (!cached_at) return undefined;
    const age = Math.max(0, Math.floor((Date.now() - Date.parse(cached_at)) / 1000));
    return String(age);
  };

  if (entry) {
    const stale = isStale({ expires_at: entry.meta.expires_at });
    const etag = entry.meta.etag || undefined;
    const headers: Record<string, string> = {
      'X-UC-Cache': bypass ? 'BYPASS' : stale ? 'STALE' : 'HIT',
    };
    const age = ageSec(entry.meta.cached_at);
    if (age) headers['X-UC-Age'] = age;
    if (etag) headers['ETag'] = etag;

    // enqueue background refresh if stale or explicitly bypassed
    if (stale || bypass) {
      // fire-and-forget
      enqueueRefresh({ source_id, key: entry.meta.key }).catch(() => {});
    }

    if (ifNoneMatch && etag && ifNoneMatch.split(/\s*,\s*/).includes(etag)) {
      return new Response(null, { status: 304, headers });
    }

    return json({ data: entry.data, meta: { ...entry.meta, stale } }, 200, headers);
  }

  // MISS
  if (cacheOnly) {
    return json({ error: 'Cache miss' }, 404, { 'X-UC-Cache': 'MISS' });
  }
  const r = await enqueueRefresh({ source_id, key });
  return json({ ok: true, endpoint: 'cache-get', enqueued: r.enqueued, task_id: r.jobId, source_id, key }, 202, {
    'X-UC-Cache': 'MISS',
    'X-UC-Task-Id': r.jobId ?? '',
  });
}

export default async (req: Request, context: Context) => {
  return GET(req, context);
};
