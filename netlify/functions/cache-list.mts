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
  const prefix = url.searchParams.get("prefix") ?? "";
  const cursor = url.searchParams.get("cursor");
  const limit = Number(url.searchParams.get("limit") ?? 50);
  return json({ ok: true, endpoint: "cache-list", source_id, items: [], next_cursor: null, limit, prefix, cursor });
};

export const config: Config = {
  path: "/api/v1/cache/:source_id/list",
};
