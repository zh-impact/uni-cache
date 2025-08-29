import type { Config, Context } from "@netlify/functions";

function json(_data: unknown, status = 204, headers: Record<string, string> = {}) {
  return new Response(null, { status, headers });
}

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers: { "content-type": "application/json; charset=utf-8" } });
  const params = context.params || {};
  const _source_id = params["source_id"] as string | undefined;
  const _key = params["key"] as string | undefined;
  return json(null, 204);
};

export const config: Config = {
  path: "/api/v1/cache/:source_id/:key/invalidate",
};
