import type { Config, Context } from '@netlify/functions';

import { getCacheEntry, isStale } from '../lib/cache.mjs';
import { json } from '../lib/server.mjs';

export const config: Config = {
  path: '/api/v1/cache/:source_id/:key/meta',
  method: 'GET',
};

async function GET(req: Request, context: Context) {
  const url = new URL(req.url);
  const params = context.params || {};
  const source_id = (params['source_id'] as string) ?? url.searchParams.get('source_id') ?? undefined;
  const key = (params['key'] as string) ?? url.searchParams.get('key') ?? undefined;
  if (!source_id || !key) return json({ error: 'source_id and key are required' }, 422);

  const entry = await getCacheEntry(source_id, key);
  if (!entry) return json({ error: 'Cache miss' }, 404, { 'X-UC-Cache': 'MISS' });

  const stale = isStale({ expires_at: entry.meta.expires_at });
  const headers: Record<string, string> = { 'X-UC-Cache': stale ? 'STALE' : 'HIT' };
  const etag = entry.meta.etag || undefined;
  if (etag) headers['ETag'] = etag;
  if (entry.meta.cached_at) {
    const age = Math.max(0, Math.floor((Date.now() - Date.parse(entry.meta.cached_at)) / 1000));
    headers['X-UC-Age'] = String(age);
  }

  const ifNoneMatch = req.headers.get('If-None-Match');
  if (ifNoneMatch && etag && ifNoneMatch.split(/\s*,\s*/).includes(etag)) {
    return new Response(null, { status: 304, headers });
  }

  return json({ key: entry.meta.key, source_id: entry.meta.source_id, meta: { ...entry.meta, stale } }, 200, headers);
}

export default async (req: Request, context: Context) => {
  return GET(req, context);
};
