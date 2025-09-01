import type { Config, Context } from "@netlify/functions";

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export async function GET(_req: Request, _context: Context) {
  return json({ name: "uni-cache", version: "dev", time: new Date().toISOString() });
}

export default async (req: Request, context: Context) => {
  return GET(req, context);
};

export const config: Config = {
  path: "/api/v1/info",
  method: "GET",
};
