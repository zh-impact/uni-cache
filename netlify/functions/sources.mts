import type { Config, Context } from '@netlify/functions';
import { sql } from '../lib/db.mjs';

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

// TODO:
// - 接入 Neon Postgres 持久化 Source：id, name, base_url, default_headers, default_query, rate_limit, cache_ttl_s, key_template
// - 校验请求体并返回 400/422 等错误码
// - 幂等创建（可用 Idempotency-Key）
// - 鉴权：仅管理员可访问
export default async (req: Request, _context: Context) => {
  const method = req.method.toUpperCase();

  if (method === 'GET') {
    const items = await sql/*sql*/ `
      SELECT id, name, base_url, default_headers, default_query, rate_limit, cache_ttl_s, key_template
      FROM sources ORDER BY id
    `;
    return json({ ok: true, endpoint: 'sources', items }, 200);
  }

  if (method === 'POST') {
    let body: any = {};
    try {
      body = await req.json();
    } catch {}

    // 最小校验：id 必填
    if (!body || typeof body.id !== 'string' || !body.id.trim()) {
      return json({ error: 'id is required' }, 422);
    }

    // 创建：若 id 已存在则返回 409 Conflict，避免覆盖已有 Source。
    // 使用 ON CONFLICT DO NOTHING + RETURNING 防止并发竞态下的重复插入。
    const created = await sql/*sql*/`
    INSERT INTO sources (id, name, base_url, default_headers, default_query, rate_limit, cache_ttl_s, key_template)
    VALUES (
      ${body.id},
      ${body.name ?? body.id},
      ${body.base_url ?? ''},
      ${JSON.stringify(body.default_headers ?? {})}::jsonb,
      ${JSON.stringify(body.default_query ?? {})}::jsonb,
      ${JSON.stringify(body.rate_limit ?? { per_minute: 5 })}::jsonb,
      ${body.cache_ttl_s ?? 600},
      ${body.key_template ?? '/'}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id, name, base_url, default_headers, default_query, rate_limit, cache_ttl_s, key_template
    `;
    if (!created.length) {
      return json({ error: 'Source already exists', id: body.id }, 409);
    }
    return json(created[0], 201);
  }

  return json({ error: 'Method Not Allowed' }, 405);
};

export const config: Config = {
  path: '/api/v1/sources',
};
