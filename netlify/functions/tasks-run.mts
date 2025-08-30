import type { Config, Context } from "@netlify/functions";
import { runOnce } from "../lib/runner.mjs";
import { enqueueManyRefresh } from "../lib/queue.mjs";
import { redis } from "../lib/redis.mjs";
import { redisQueueKey } from "../lib/key.mjs";
import type { EnqueueResult } from "../lib/types.mjs";

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  const url = new URL(req.url);
  const qp = url.searchParams;
  const body = (await req.json().catch(() => ({} as any))) as any;

  const source_id = (body?.source_id as string | undefined) ?? qp.get("source_id") ?? undefined;

  const parseNum = (v: unknown): number | undefined => {
    if (v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  const maxPerSource = parseNum(body?.max_per_source ?? qp.get("max_per_source"));
  const timeBudgetMs = parseNum(body?.time_budget_ms ?? qp.get("time_budget_ms"));

  // 可选：当手动触发且队列为空时，先对指定 keys 入队（继续走队列语义）
  const keys: string[] = Array.isArray(body?.keys) ? (body.keys as string[]) : [];
  let prefetch: null | { enqueued: number; duplicates: number; idempotent_rejects: number; task_ids: string[] } = null;
  let queue_len_before: number | null = null;
  let queue_len_after_enqueue: number | null = null;
  let queue_len_after_run: number | null = null;
  if (source_id && keys.length > 0) {
    const qkey = redisQueueKey(source_id);
    const qlen = await redis.llen(qkey);
    queue_len_before = qlen;
    if (qlen === 0) {
      const idempotencyKey = req.headers.get("Idempotency-Key");
      const jobs = keys.map((k: string) => ({ source_id, key: k }));
      const results: EnqueueResult[] = await enqueueManyRefresh(jobs, { idempotencyKey: idempotencyKey ?? undefined });
      const task_ids = results.map((r) => r.jobId).filter(Boolean) as string[];
      const enqueued = results.filter((r) => r.enqueued).length;
      const duplicates = results.filter((r) => r.reason === "duplicate").length;
      const idempRejects = results.filter((r) => r.reason === "idempotent_reject").length;
      prefetch = { enqueued, duplicates, idempotent_rejects: idempRejects, task_ids };
      queue_len_after_enqueue = await redis.llen(qkey);
      console.log("tasks-run prefetch:", {
        source_id,
        keys_count: keys.length,
        queue_len_before,
        queue_len_after_enqueue,
        enqueued,
        duplicates,
        idempotent_rejects: idempRejects,
        task_ids_count: task_ids.length,
      });
    } else {
      console.log("tasks-run skip prefetch because queue not empty:", { source_id, queue_len_before });
    }
  }

  const runOpts = {
    source_id: source_id ?? undefined,
    maxPerSource: maxPerSource,
    timeBudgetMs: timeBudgetMs,
  } as const;
  console.log("tasks-run invoking runOnce with:", runOpts);
  const summary = await runOnce({ ...runOpts });
  if (source_id) {
    const qkey = redisQueueKey(source_id);
    queue_len_after_run = await redis.llen(qkey);
  }
  console.log("tasks-run runOnce summary:", { summary, queue_len_after_run });

  const resp: any = { ...summary, endpoint: "tasks-run", source_id: source_id ?? null };
  if (prefetch) resp.prefetch = prefetch;
  resp.debug = {
    queue_len_before,
    queue_len_after_enqueue,
    queue_len_after_run,
    run_opts: runOpts,
  };
  return json(resp, 200);
};

export const config: Config = {
  path: "/api/v1/tasks/run",
};
