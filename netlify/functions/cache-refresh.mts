import type { Config, Context } from "@netlify/functions";

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
  const params = context.params || {};
  const source_id = params["source_id"] as string | undefined;
  const key = params["key"] as string | undefined;
  return json({ ok: true, endpoint: "cache-refresh", task_id: `t_${Date.now()}`, source_id, key }, 202);
};

export const config: Config = {
  path: "/api/v1/cache/:source_id/:key/refresh",
};
