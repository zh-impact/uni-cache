import type { Config, Context } from "@netlify/functions";

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
  const url = new URL(req.url);
  const source_id = url.searchParams.get("source_id");
  return json({ ok: true, endpoint: "tasks-run", task_id: `t_run_${Date.now()}`, source_id }, 202);
};

export const config: Config = {
  path: "/api/v1/tasks/run",
};
