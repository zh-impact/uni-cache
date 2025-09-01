import type { Config, Context } from '@netlify/functions';

import { json } from '../lib/server.mjs';

export const config: Config = {
  path: '/api/v1/healthz',
  method: 'GET',
};

async function GET(_req: Request, _context: Context) {
  return json({ status: 'ok', time: new Date().toISOString() });
}

export default async (req: Request, context: Context) => {
  return GET(req, context);
};
