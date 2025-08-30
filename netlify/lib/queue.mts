// netlify/lib/queue.mts
import { redis } from './redis.mjs';
import { keyHash, normalizeKeyString, redisKeyDedup, redisKeyIdemp, redisQueueKey } from './key.mjs';
import type { EnqueueResult, RefreshJob } from './types.mjs';
import { createHash } from 'node:crypto';

export const DEFAULT_DEDUPE_TTL_S = 60; // 同键去重窗口
export const DEFAULT_IDEMP_TTL_S = 15 * 60; // Idempotency-Key 生效窗口

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

  // 1) Idempotency-Key 保护（若提供则优先生效）
  if (opts.idempotencyKey) {
    const idHash = sha1(`${source_id}:refresh:${normalizedKey}:${opts.idempotencyKey}`);
    const idKey = redisKeyIdemp(idHash);
    const idemp = await redis.set(idKey, '1', { nx: true, ex: opts.idempTtlS ?? DEFAULT_IDEMP_TTL_S });
    if (idemp !== 'OK') {
      return { enqueued: false, reason: 'idempotent_reject' };
    }
  }

  // 2) 同键去重窗口（避免瞬时重复刷新）
  const dedupKey = redisKeyDedup(source_id, kh);
  const ok = await redis.set(dedupKey, '1', { nx: true, ex: opts.dedupeTtlS ?? DEFAULT_DEDUPE_TTL_S });
  if (ok !== 'OK') {
    return { enqueued: false, reason: 'duplicate' };
  }

  // 3) 入队（每源一条 List）
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
    // 对批量不强制共享同一个 Idempotency-Key；由调用侧决定是否传入统一 idempotencyKey
    // 这里逐个入队，保持实现简单。如需性能，可改为 pipeline。
    // eslint-disable-next-line no-await-in-loop
    const r = await enqueueRefresh(j, opts);
    results.push(r);
  }
  return results;
}
