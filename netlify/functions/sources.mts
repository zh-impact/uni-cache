import type { Config, Context } from '@netlify/functions';
import { sql } from '../lib/db.mjs';
import { ensureSourcesSupportsPoolColumn } from '../lib/sources-pg.mjs';

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

// TODO:
// - Integrate Neon Postgres for persisting Source: id, name, base_url, default_headers, default_query, rate_limit, cache_ttl_s, key_template
// - Validate request body and return 400/422 error codes when invalid
// - Idempotent creation (with Idempotency-Key)
// - Authorization: admin-only access
export default async (req: Request, _context: Context) => {
  const method = req.method.toUpperCase();
  // Try to ensure the supports_pool column exists (idempotent)
  await ensureSourcesSupportsPoolColumn().catch(() => {});

  if (method === 'GET') {
    const items = await sql/*sql*/ `
      SELECT id, name, base_url, default_headers, default_query, rate_limit, cache_ttl_s, key_template, supports_pool
      FROM sources ORDER BY id
    `;
    return json({ ok: true, endpoint: 'sources', items }, 200);
  }

  if (method === 'POST') {
    let body: any = {};
    try {
      body = await req.json();
    } catch {}

    // Minimal validation: id is required
    if (!body || typeof body.id !== 'string' || !body.id.trim()) {
      return json({ error: 'id is required' }, 422);
    }

    // Create: if the id already exists, return 409 Conflict to avoid overwriting an existing Source.
    // Use ON CONFLICT DO NOTHING + RETURNING to prevent duplicate inserts under concurrency.
    const created = await sql/*sql*/`
    INSERT INTO sources (id, name, base_url, default_headers, default_query, rate_limit, cache_ttl_s, key_template, supports_pool)
    VALUES (
      ${body.id},
      ${body.name ?? body.id},
      ${body.base_url ?? ''},
      ${JSON.stringify(body.default_headers ?? {})}::jsonb,
      ${JSON.stringify(body.default_query ?? {})}::jsonb,
      ${JSON.stringify(body.rate_limit ?? { per_minute: 5 })}::jsonb,
      ${body.cache_ttl_s ?? 600},
      ${body.key_template ?? '/'},
      ${Boolean(body.supports_pool ?? false)}
    )
    ON CONFLICT (id) DO NOTHING
    RETURNING id, name, base_url, default_headers, default_query, rate_limit, cache_ttl_s, key_template, supports_pool
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
