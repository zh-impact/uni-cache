// netlify/lib/queue.mts
import { redis } from './redis.mjs';
import { keyHash, normalizeKeyString, redisKeyDedup, redisKeyIdemp, redisQueueKey } from './key.mjs';
import type { EnqueueResult, RefreshJob } from './types.mjs';
import { createHash } from 'node:crypto';

export const DEFAULT_DEDUPE_TTL_S = 60; // same-key dedupe window
export const DEFAULT_IDEMP_TTL_S = 15 * 60; // Idempotency-Key validity window

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

export function createJobId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `j_${Date.now()}_${rand}`;
}

export interface EnqueueOptions {
  idempotencyKey?: string | null;
  dedupeTtlS?: number;
  idempTtlS?: number;
}

export async function enqueueRefresh(job: RefreshJob, opts: EnqueueOptions = {}): Promise<EnqueueResult> {
  const source_id = job.source_id;
  const normalizedKey = normalizeKeyString(job.key);
  const kh = keyHash(normalizedKey);

  // 1) Idempotency-Key guard (takes precedence when provided)
  if (opts.idempotencyKey) {
    const idHash = sha1(`${source_id}:refresh:${normalizedKey}:${opts.idempotencyKey}`);
    const idKey = redisKeyIdemp(idHash);
    const idemp = await redis.set(idKey, '1', { nx: true, ex: opts.idempTtlS ?? DEFAULT_IDEMP_TTL_S });
    if (idemp !== 'OK') {
      return { enqueued: false, reason: 'idempotent_reject' };
    }
  }

  // 2) Same-key dedupe window (avoid burst duplicate refreshes)
  const dedupKey = redisKeyDedup(source_id, kh);
  const ok = await redis.set(dedupKey, '1', { nx: true, ex: opts.dedupeTtlS ?? DEFAULT_DEDUPE_TTL_S });
  if (ok !== 'OK') {
    return { enqueued: false, reason: 'duplicate' };
  }

  // 3) Enqueue (one list per source)
  const qkey = redisQueueKey(source_id);
  const jobId = createJobId();
  const record: Required<RefreshJob> = {
    id: jobId,
    source_id,
    key: normalizedKey,
    priority: job.priority ?? 'normal',
    attempts: 0,
    enqueued_at: new Date().toISOString(),
  };
  await redis.rpush(qkey, JSON.stringify(record));
  return { enqueued: true, jobId };
}

export async function enqueueManyRefresh(jobs: RefreshJob[], opts: EnqueueOptions = {}): Promise<EnqueueResult[]> {
  const results: EnqueueResult[] = [];
  for (const j of jobs) {
    // For batches, do not enforce a shared Idempotency-Key; the caller decides whether to pass a unified idempotencyKey.
    // Enqueue one by one to keep the implementation simple. For performance, could switch to a pipeline.
    // eslint-disable-next-line no-await-in-loop
    const r = await enqueueRefresh(j, opts);
    results.push(r);
  }
  return results;
}
