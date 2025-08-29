import type { Config, Context } from "@netlify/functions";

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export default async (req: Request, context: Context) => {
  if (req.method !== "GET") return json({ error: "Method Not Allowed" }, 405);

  const url = new URL(req.url);
  const params = context.params || {};
  const source_id = (params["source_id"] as string) ?? url.searchParams.get("source_id") ?? undefined;
  const key = (params["key"] as string) ?? url.searchParams.get("key") ?? undefined;

  return json(
    {
      ok: true,
      endpoint: "cache-get",
      data: null,
      meta: { source_id, key },
    },
    200,
    { "X-UC-Cache": "MISS" }
  );
};

export const config: Config = {
  path: "/api/v1/cache/:source_id/:key",
};
