import type { Config, Context } from "@netlify/functions";

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export default async (req: Request, context: Context) => {
  if (req.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
  const params = context.params || {};
  const task_id = (params["task_id"] as string) ?? null;
  return json({ ok: true, endpoint: "tasks-status", task_id, state: "queued", progress: 0 });
};

export const config: Config = {
  path: "/api/v1/tasks/:task_id",
};
