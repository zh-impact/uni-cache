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
  const source_id = (params["source_id"] as string) ?? null;
  return json({ ok: true, endpoint: "rate-limit", source_id, per_minute: 5, remaining: 5, reset_at: new Date(Date.now() + 60_000).toISOString() });
};

export const config: Config = {
  path: "/api/v1/rate-limit/:source_id",
};
