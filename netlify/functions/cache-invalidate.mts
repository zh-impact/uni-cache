import type { Config, Context } from '@netlify/functions';

import { delCacheEntry } from '../lib/cache.mjs';
import { json } from '../lib/server.mjs';

export const config: Config = {
  path: '/api/v1/cache/:source_id/:key/invalidate',
  method: 'POST',
};

async function POST(_req: Request, context: Context) {
  const params = context.params || {};
  const source_id = params['source_id'] as string | undefined;
  const key = params['key'] as string | undefined;
  if (!source_id || !key) {
    return new Response(JSON.stringify({ error: 'source_id and key are required' }), {
      status: 422,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const deleted = await delCacheEntry(source_id, key);
  return json(null, 204, { 'X-UC-Deleted': String(deleted) });
}

export default async (req: Request, context: Context) => {
  return POST(req, context);
};
