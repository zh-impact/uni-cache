import type { Config, Context } from "@netlify/functions";
import { runOnce } from "../lib/runner.mjs";

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

  const summary = await runOnce({
    source_id: source_id ?? undefined,
    maxPerSource: maxPerSource,
    timeBudgetMs: timeBudgetMs,
  });

  return json({ ...summary, endpoint: "tasks-run", source_id: source_id ?? null }, 200);
};

export const config: Config = {
  path: "/api/v1/tasks/run",
};
