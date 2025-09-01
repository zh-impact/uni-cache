import type { Config, Context } from '@netlify/functions';

import { json } from '../lib/server.mjs';

export const config: Config = {
  path: '/api/v1/cache/:source_id/list',
  method: 'GET',
};

async function GET(req: Request, context: Context) {
  const url = new URL(req.url);
  const params = context.params || {};
  const source_id = (params['source_id'] as string) ?? url.searchParams.get('source_id') ?? undefined;
  const prefix = url.searchParams.get('prefix') ?? '';
  const cursor = url.searchParams.get('cursor');
  const limit = Number(url.searchParams.get('limit') ?? 50);
  return json({ ok: true, endpoint: 'cache-list', source_id, items: [], next_cursor: null, limit, prefix, cursor });
}

export default async (req: Request, context: Context) => {
  return GET(req, context);
};
