import type { Config, Context } from '@netlify/functions';

import type { CacheEntry } from '../lib/types.mjs';
import { getCacheEntry, isStale } from '../lib/cache.mjs';
import { enqueueRefresh } from '../lib/queue.mjs';
import { json } from '../lib/server.mjs';

export const config: Config = {
  path: '/api/v1/cache/:source_id/batch-get',
  method: 'POST',
};

async function POST(req: Request, context: Context) {
  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  const params = context.params || {};
  const source_id = (params['source_id'] as string) ?? undefined;
  if (!source_id) return json({ error: 'source_id is required' }, 422);

  const keys: string[] = Array.isArray(body?.keys) ? body.keys : [];
  if (!keys.length) return json({ error: 'keys is required and must be a non-empty array' }, 422);

  const bypass = /^true|1$/i.test(req.headers.get('X-UC-Bypass-Cache') || '');
  const cacheOnly = /^true|1$/i.test(req.headers.get('X-UC-Cache-Only') || '');

  const items = await Promise.all(
    keys.map(async (k) => {
      const entry: CacheEntry | null = await getCacheEntry(source_id, k);
      if (!entry) {
        if (!cacheOnly) {
          enqueueRefresh({ source_id, key: k }).catch(() => {});
        }
        return { key: k, hit: false, data: null, meta: { stale: null as null | boolean } };
      }
      const stale = isStale({ expires_at: entry.meta.expires_at });
      if (stale || bypass) {
        enqueueRefresh({ source_id, key: entry.meta.key }).catch(() => {});
      }
      return {
        key: entry.meta.key,
        hit: true,
        data: entry.data,
        meta: { ...entry.meta, stale },
      };
    })
  );

  const enqCount = items.filter((it) => it.hit === false).length; // approximate; exact would need enqueue results
  return json({ ok: true, endpoint: 'cache-batch-get', items }, 200, { 'X-UC-Tasks-Count': String(enqCount) });
}

export default async (req: Request, context: Context) => {
  return POST(req, context);
};
