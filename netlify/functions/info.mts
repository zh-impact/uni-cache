import type { Config, Context } from '@netlify/functions';

import { json } from '../lib/server.mjs';

export const config: Config = {
  path: '/api/v1/info',
  method: 'GET',
};

async function GET(_req: Request, _context: Context) {
  return json({ name: 'uni-cache', version: 'dev', time: new Date().toISOString() });
}

export default async (req: Request, context: Context) => {
  return GET(req, context);
};
