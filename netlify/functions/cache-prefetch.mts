import type { Config, Context } from '@netlify/functions';
import { enqueueManyRefresh } from '../lib/queue.mjs';
import type { EnqueueResult } from '../lib/types.mjs';

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export default async (req: Request, context: Context) => {
  if (req.method !== 'POST') return json({ error: 'Method Not Allowed' }, 405);
  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  const keys: string[] = Array.isArray(body?.keys) ? body.keys : [];
  const params = context.params || {};
  const source_id = params['source_id'] as string | undefined;
  if (!source_id) return json({ error: 'source_id is required' }, 422);
  if (!keys.length) return json({ error: 'keys is required and must be a non-empty array' }, 422);

  const idempotencyKey = req.headers.get('Idempotency-Key');
  const jobs = keys.map((k) => ({ source_id, key: k }));
  const results: EnqueueResult[] = await enqueueManyRefresh(jobs, { idempotencyKey });
  const task_ids = results.map((r: EnqueueResult) => r.jobId).filter(Boolean) as string[];
  const enqueued = results.filter((r: EnqueueResult) => r.enqueued).length;
  const duplicates = results.filter((r: EnqueueResult) => r.reason === 'duplicate').length;
  const idempRejects = results.filter((r: EnqueueResult) => r.reason === 'idempotent_reject').length;
  return json(
    {
      ok: true,
      endpoint: 'cache-prefetch',
      source_id,
      enqueued,
      duplicates,
      idempotent_rejects: idempRejects,
      task_ids,
      results,
    },
    202,
    { 'X-UC-Tasks-Count': String(task_ids.length) }
  );
};

export const config: Config = {
  path: '/api/v1/cache/:source_id/prefetch',
};
