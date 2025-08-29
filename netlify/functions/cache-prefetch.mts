import type { Config, Context } from "@netlify/functions";

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
  let body: any = {};
  try { body = await req.json(); } catch {}
  const keys: string[] = Array.isArray(body?.keys) ? body.keys : [];
  const params = context.params || {};
  const source_id = params["source_id"] as string | undefined;
  return json({ ok: true, endpoint: "cache-prefetch", source_id, task_ids: keys.map((_, i) => `t_${Date.now()}_${i}`) }, 202);
};

export const config: Config = {
  path: "/api/v1/cache/:source_id/prefetch",
};
