import type { Config, Context } from '@netlify/functions';
import { asc } from 'drizzle-orm';

import { db } from '../lib/drizzle.mjs';
import { sources } from '../../src/db/schema.ts';
import { ensureSourcesSupportsPoolColumn } from '../lib/sources-pg.mjs';
import { json } from '../lib/server.mjs';

export const config: Config = {
  path: '/api/v1/sources',
  method: ['GET', 'POST'],
};

// TODO:
// - Integrate Neon Postgres for persisting Source: id, name, base_url, default_headers, default_query, rate_limit, cache_ttl_s, key_template
// - Validate request body and return 400/422 error codes when invalid
// - Idempotent creation (with Idempotency-Key)
// - Authorization: admin-only access
async function GET(_req: Request, _context: Context) {
  const items = await db.select().from(sources).orderBy(asc(sources.id));
  return json({ ok: true, endpoint: 'sources', items }, 200);
}

async function POST(req: Request, _context: Context) {
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
  const values: typeof sources.$inferInsert = {
    id: body.id,
    name: body.name ?? body.id,
    base_url: body.base_url ?? '',
    default_headers: body.default_headers ?? {},
    default_query: body.default_query ?? {},
    rate_limit: body.rate_limit ?? { per_minute: 5 },
    cache_ttl_s: body.cache_ttl_s ?? 600,
    key_template: body.key_template ?? '/',
    supports_pool: Boolean(body.supports_pool ?? false),
  };

  const created = await db.insert(sources).values(values).onConflictDoNothing({ target: sources.id }).returning();

  if (!created.length) {
    return json({ error: 'Source already exists', id: body.id }, 409);
  }
  return json(created[0], 201);
}

export default async (req: Request, _context: Context) => {
  const method = req.method.toUpperCase();
  // Try to ensure the supports_pool column exists (idempotent)
  await ensureSourcesSupportsPoolColumn().catch(() => {});

  if (method === 'GET') return GET(req, _context);
  if (method === 'POST') return POST(req, _context);
  // Fallback should not be reached because Config.method restricts allowed methods
  return GET(req, _context);
};
