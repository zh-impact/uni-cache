import type { Config, Context } from '@netlify/functions';
import { acquire } from '../lib/rate-limit.mjs';

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export async function GET(req: Request, context: Context) {
  const params = context.params || {};
  const source_id = (params['source_id'] as string) ?? undefined;
  if (!source_id) return json({ error: 'source_id is required' }, 422);
  const cfg = { per_minute: 5 };
  const decision = await acquire(source_id, cfg);
  return json(
    {
      ok: true,
      endpoint: 'rate-limit',
      source_id,
      per_minute: cfg.per_minute,
      remaining: decision.remaining,
      reset_at: decision.reset_at,
    },
    200,
    {
      'X-RateLimit-Limit': String(decision.limit),
      'X-RateLimit-Remaining': String(decision.remaining),
      'X-RateLimit-Reset': decision.reset_at,
    }
  );
}

export default async (req: Request, context: Context) => {
  return GET(req, context);
};

export const config: Config = {
  path: '/api/v1/rate-limit/:source_id',
  method: 'GET',
};
