import type { Config, Context } from "@netlify/functions";

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);
  let body: any = {};
  try {
    body = await req.json();
  } catch {}
  const keys: string[] = Array.isArray(body?.keys) ? body.keys : [];
  return json({
    ok: true,
    endpoint: "cache-batch-get",
    items: keys.map((k) => ({ key: k, hit: false, data: null, meta: { stale: null } })),
  });
};

export const config: Config = {
  path: "/api/v1/cache/:source_id/batch-get",
};
