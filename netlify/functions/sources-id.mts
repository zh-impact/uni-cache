import type { Config, Context } from "@netlify/functions";
import { sql } from '../lib/db.mjs';
import { ensureSourcesSupportsPoolColumn } from '../lib/sources-pg.mjs';

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

// TODO:
// - Persist read/write for a single Source (Neon Postgres)
// - Support partial updates: PATCH only updates provided fields
// - Support ?keep_cache=1 on delete
// - Authentication and audit logging
export default async (req: Request, context: Context) => {
  const method = req.method.toUpperCase();
  const params = context.params || {};
  const source_id = params["source_id"] as string | undefined;

  if (!source_id) return json({ error: "source_id is required" }, 400);

  // Ensure the column exists (idempotent)
  await ensureSourcesSupportsPoolColumn().catch(() => {});

  if (method === "GET") {
    // Placeholder: return a record if found, otherwise 404.
    const item = await sql/*sql*/`
      SELECT id, name, base_url, default_headers, default_query, rate_limit, cache_ttl_s, key_template, supports_pool
      FROM sources WHERE id = ${source_id}
    `;
    if (!item.length) return json({ error: "Source not found" }, 404);
    return json(item[0], 200);
  }

  if (method === "PATCH") {
    let body: any = {};
    try { body = await req.json(); } catch {}
    // Placeholder: apply a partial update and echo the updated row
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
      supports_pool = COALESCE(${body.supports_pool ?? null}, supports_pool),
      updated_at = now()
    WHERE id = ${source_id}
    RETURNING id, name, base_url, default_headers, default_query, rate_limit, cache_ttl_s, key_template, supports_pool
    `;
    return json(updated[0], 200);
  }

  if (method === "DELETE") {
    // Placeholder: mark deletion success
    const deleted = await sql/*sql*/`
    DELETE FROM sources WHERE id = ${source_id}
    RETURNING id, name, base_url, default_headers, default_query, rate_limit, cache_ttl_s, key_template, supports_pool
    `;
    return json(deleted[0], 204);
  }

  return json({ error: "Method Not Allowed" }, 405);
};

export const config: Config = {
  path: "/api/v1/sources/:source_id",
};
