import type { Config, Context } from "@netlify/functions";
import { eq } from 'drizzle-orm';
import { db } from '../lib/drizzle.mjs';
import { sources } from '../../src/db/schema.ts';
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
    const rows = await db.select().from(sources).where(eq(sources.id, source_id));
    if (!rows.length) return json({ error: "Source not found" }, 404);
    return json(rows[0], 200);
  }

  if (method === "PATCH") {
    let body: any = {};
    try { body = await req.json(); } catch {}

    const updateValues: Partial<typeof sources.$inferInsert> = {
      name: body.name ?? source_id,
      base_url: body.base_url ?? '',
      default_headers: body.default_headers ?? {},
      default_query: body.default_query ?? {},
      rate_limit: body.rate_limit ?? { per_minute: 5 },
      cache_ttl_s: body.cache_ttl_s ?? 600,
      key_template: body.key_template ?? '/',
      // supports_pool preserves existing value if not provided
    };
    if (typeof body.supports_pool === 'boolean') {
      updateValues.supports_pool = body.supports_pool;
    }

    const updated = await db
      .update(sources)
      .set(updateValues)
      .where(eq(sources.id, source_id))
      .returning();

    if (!updated.length) return json({ error: "Source not found" }, 404);
    return json(updated[0], 200);
  }

  if (method === "DELETE") {
    const deleted = await db.delete(sources).where(eq(sources.id, source_id)).returning();
    if (!deleted.length) return json({ error: "Source not found" }, 404);
    return json(deleted[0], 204);
  }

  return json({ error: "Method Not Allowed" }, 405);
};

export const config: Config = {
  path: "/api/v1/sources/:source_id",
};
