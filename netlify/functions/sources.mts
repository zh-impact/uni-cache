import type { Config, Context } from "@netlify/functions";

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

// TODO:
// - 接入 Neon Postgres 持久化 Source：id, name, base_url, default_headers, default_query, rate_limit, cache_ttl_s, key_template
// - 校验请求体并返回 400/422 等错误码
// - 幂等创建（可用 Idempotency-Key）
// - 鉴权：仅管理员可访问
export default async (req: Request, _context: Context) => {
  const method = req.method.toUpperCase();

  if (method === "GET") {
    // 列表（占位实现）。未来从数据库读取。
    return json({ ok: true, endpoint: "sources", items: [] }, 200);
  }

  if (method === "POST") {
    let body: any = {};
    try { body = await req.json(); } catch {}

    // 最小校验：id 必填
    if (!body || typeof body.id !== "string" || !body.id.trim()) {
      return json({ error: "id is required" }, 422);
    }

    // 创建（占位实现）：直接回显请求体，并补齐默认字段。
    const created = {
      id: body.id,
      name: body.name ?? body.id,
      base_url: body.base_url ?? "",
      default_headers: body.default_headers ?? {},
      default_query: body.default_query ?? {},
      rate_limit: body.rate_limit ?? { per_minute: 5 },
      cache_ttl_s: body.cache_ttl_s ?? 600,
      key_template: body.key_template ?? "/",
    };

    return json(created, 201);
  }

  return json({ error: "Method Not Allowed" }, 405);
};

export const config: Config = {
  path: "/api/v1/sources",
};
