import type { Config, Context } from '@netlify/functions';
import { enqueueRefresh } from '../lib/queue.mjs';

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export async function POST(req: Request, context: Context) {
  const params = context.params || {};
  const source_id = params['source_id'] as string | undefined;
  const key = params['key'] as string | undefined;

  if (!source_id || !key) {
    return json({ error: 'source_id and key are required' }, 422);
  }

  const idempotencyKey = req.headers.get('Idempotency-Key');
  const result = await enqueueRefresh({ source_id, key }, { idempotencyKey });

  if (result.enqueued) {
    return json({ ok: true, endpoint: 'cache-refresh', task_id: result.jobId, source_id, key }, 202, {
      'X-UC-Task-Id': result.jobId ?? '',
    });
  }

  if (result.reason === 'idempotent_reject') {
    return json({ error: 'Idempotency conflict' }, 409);
  }
  if (result.reason === 'duplicate') {
    return json({ error: 'Duplicate job in dedupe window' }, 409);
  }
  return json({ error: 'Invalid request' }, 422);
}

export default async (req: Request, context: Context) => {
  return POST(req, context);
};

export const config: Config = {
  path: '/api/v1/cache/:source_id/:key/refresh',
  method: 'POST',
};
