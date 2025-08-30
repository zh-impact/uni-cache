import type { Config, Context } from '@netlify/functions';
import { getCacheEntry, isStale } from '../lib/cache.mjs';
import { enqueueRefresh } from '../lib/queue.mjs';
import type { CacheEntry } from '../lib/types.mjs';

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export default async (req: Request, context: Context) => {
  if (req.method !== 'GET') return json({ error: 'Method Not Allowed' }, 405);

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
};

export const config: Config = {
  path: '/api/v1/cache/:source_id/:key',
};
