import type { Config, Context } from "@netlify/functions";
import { sql } from '../lib/db.mjs';

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
    const item = await sql/*sql*/`
      SELECT id, name, base_url, default_headers, default_query, rate_limit, cache_ttl_s, key_template
      FROM sources WHERE id = ${source_id}
    `;
    if (!item.length) return json({ error: "Source not found" }, 404);
    return json(item[0], 200);
  }

  if (method === "PATCH") {
    let body: any = {};
    try { body = await req.json(); } catch {}
    // 占位：回显部分更新
    const updated = await sql/*sql*/`
    UPDATE sources
    SET
      name = ${body.name ?? source_id},
      base_url = ${body.base_url ?? ''},
      default_headers = ${JSON.stringify(body.default_headers ?? {})}::jsonb,
      default_query = ${JSON.stringify(body.default_query ?? {})}::jsonb,
      rate_limit = ${JSON.stringify(body.rate_limit ?? { per_minute: 5 })}::jsonb,
      cache_ttl_s = ${body.cache_ttl_s ?? 600},
      key_template = ${body.key_template ?? '/'},
      updated_at = now()
    WHERE id = ${source_id}
    RETURNING id, name, base_url, default_headers, default_query, rate_limit, cache_ttl_s, key_template
    `;
    return json(updated[0], 200);
  }

  if (method === "DELETE") {
    // 占位：标记删除成功
    const deleted = await sql/*sql*/`
    DELETE FROM sources WHERE id = ${source_id}
    RETURNING id, name, base_url, default_headers, default_query, rate_limit, cache_ttl_s, key_template
    `;
    return json(deleted[0], 204);
  }

  return json({ error: "Method Not Allowed" }, 405);
};

export const config: Config = {
  path: "/api/v1/sources/:source_id",
};
