import type { Config, Context } from '@netlify/functions';

import { json } from '../lib/server.mjs';

export const config: Config = {
  path: '/api/v1/metrics',
  method: 'GET',
};

async function GET(_req: Request, _context: Context) {
  return json({
    uptime_s: 0,
    cache: { hit: 0, miss: 0, stale_served: 0 },
    jobs: { queued: 0, running: 0, failed: 0 },
    sources: { count: 0 },
  });
}

export default async (req: Request, context: Context) => {
  return GET(req, context);
};
