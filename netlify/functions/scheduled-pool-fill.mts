import type { Config } from '@netlify/functions';
import { enqueueManyRefresh } from '../lib/queue.mjs';
import { redis } from '../lib/redis.mjs';
import { redisQueueKey } from '../lib/key.mjs';
import { runOnce } from '../lib/runner.mjs';
import { logger } from '../lib/logger.mjs';

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function parseIntEnv(name: string, def?: number): number | undefined {
  const v = process.env[name];
  if (v == null || v === '') return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export default async (req: Request) => {
  // Netlify Scheduled Functions 传递的 JSON 事件体可忽略
  try {
    const evt = await req.json().catch(() => ({} as any));
    if ((evt as any)?.next_run) logger.info({ event: 'scheduled-pool-fill.next_run', next_run: (evt as any).next_run });
  } catch {}

  const source_id = process.env.SCHEDULED_POOL_SOURCE_ID;
  const pool_key_raw = process.env.SCHEDULED_POOL_KEY; // e.g. /quotes
  const prefetch = parseIntEnv('SCHEDULED_POOL_PREFETCH', 2) ?? 2; // 每次预入队条数（建议与上游每分钟限速相同）
  const timeBudgetMs = parseIntEnv('SCHEDULED_POOL_TIME_BUDGET_MS', 3000);

  if (!source_id || !pool_key_raw) {
    return json({ endpoint: 'scheduled-pool-fill', error: 'SCHEDULED_POOL_SOURCE_ID and SCHEDULED_POOL_KEY are required' }, 422);
  }

  const qkey = redisQueueKey(source_id);
  const qlen = await redis.llen(qkey);

  let enqResult: null | { enqueued: number; keys: string[] } = null;
  if (qlen === 0 && prefetch > 0) {
    const now = Date.now();
    const hasQuery = String(pool_key_raw).includes('?');
    const sep = hasQuery ? '&' : '?';
    const keys: string[] = Array.from({ length: prefetch }, (_v, i) => `/pool:${pool_key_raw}${sep}i=${now}_${i}_${Math.random().toString(36).slice(2, 8)}`);
    const results = await enqueueManyRefresh(keys.map((k) => ({ source_id, key: k })), { dedupeTtlS: 10 });
    const enqueued = results.filter((r) => r.enqueued).length;
    enqResult = { enqueued, keys };
    logger.info({ event: 'scheduled-pool-fill.prefetch', source_id, enqueued, keys_count: keys.length });
  } else {
    logger.info({ event: 'scheduled-pool-fill.skip_prefetch', reason: 'queue_not_empty_or_prefetch_zero', source_id, qlen, prefetch });
  }

  // 立即消费一轮（时间预算小）
  const run = await runOnce({ source_id, maxPerSource: prefetch, timeBudgetMs });
  return json({ endpoint: 'scheduled-pool-fill', prefetch: enqResult, run }, 200);
};

export const config: Config = {
  // run every minute
  schedule: '*/1 * * * *',
};
