import type { Config, Context } from "@netlify/functions";

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

// TODO:
// - 持久化存取单个 Source（Neon Postgres）
// - 支持部分更新：PATCH 仅更新传入字段
// - 删除时可支持 ?keep_cache=1
// - 鉴权与审计日志
export default async (req: Request, context: Context) => {
  const method = req.method.toUpperCase();
  const params = context.params || {};
  const source_id = params["source_id"] as string | undefined;

  if (!source_id) return json({ error: "source_id is required" }, 400);

  if (method === "GET") {
    // 占位：返回一个示例或 404。这里默认返回示例。
    return json({ id: source_id, name: source_id, base_url: "", rate_limit: { per_minute: 5 }, cache_ttl_s: 600, key_template: "/" }, 200);
  }

  if (method === "PATCH") {
    let body: any = {};
    try { body = await req.json(); } catch {}
    // 占位：回显部分更新
    return json({ id: source_id, ...body }, 200);
  }

  if (method === "DELETE") {
    // 占位：标记删除成功
    return new Response(null, { status: 204 });
  }

  return json({ error: "Method Not Allowed" }, 405);
};

export const config: Config = {
  path: "/api/v1/sources/:source_id",
};
