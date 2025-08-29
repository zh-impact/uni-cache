import type { Config, Context } from "@netlify/functions";

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "GET") return json({ error: "Method Not Allowed" }, 405);
  return json({ status: "ok", time: new Date().toISOString() });
};

export const config: Config = {
  path: "/api/v1/healthz",
};
