// netlify/lib/pool-pg.mts
import { sql } from './db.mjs';
import { keyHash, normalizeKeyString } from './key.mjs';

// Neon 返回 JSON 列可能为 string，这里做一次宽松解析
function parseMaybeObj<T>(v: unknown): T | null {
  if (!v) return null;
  if (typeof v === 'string') {
    try {
      const o = JSON.parse(v);
      return (o ?? null) as T | null;
    } catch {
      return null;
    }
  }
  if (typeof v === 'object') return v as T;
  return null;
}

let _ensurePromise: Promise<void> | null = null;
async function ensureTable() {
  if (_ensurePromise) return _ensurePromise;
  _ensurePromise = (async () => {
    await sql/*sql*/`
      CREATE TABLE IF NOT EXISTS pool_entries (
        source_id     TEXT NOT NULL,
        pool_key      TEXT NOT NULL,
        key_hash      TEXT NOT NULL,
        item_id       TEXT NOT NULL,
        item          JSONB NOT NULL,
        encoding      TEXT NOT NULL,
        content_type  TEXT NULL,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (source_id, key_hash, item_id)
      )
    `;
    await sql/*sql*/`
      CREATE INDEX IF NOT EXISTS pool_entries_source_key_idx
      ON pool_entries(source_id, pool_key)
    `;
  })();
  return _ensurePromise;
}

export interface PgPoolItemRow {
  item_id: string;
  item: unknown;
  encoding: string;
  content_type: string | null;
  created_at: string;
}

export async function pgPoolAddItem(
  source_id: string,
  pool_key: string,
  payload: { item_id: string; item: unknown; encoding: string; content_type?: string | null; created_at?: string }
): Promise<void> {
  await ensureTable();
  const normalized = normalizeKeyString(pool_key);
  const kh = keyHash(normalized);
  const created_at = payload.created_at ?? new Date().toISOString();
  const itemJson = JSON.stringify(payload.item);
  await sql/*sql*/`
    INSERT INTO pool_entries (
      source_id, pool_key, key_hash, item_id, item, encoding, content_type, created_at
    ) VALUES (
      ${source_id}, ${normalized}, ${kh}, ${payload.item_id}, ${itemJson}::jsonb, ${payload.encoding}, ${payload.content_type ?? null}, ${created_at}
    )
    ON CONFLICT (source_id, key_hash, item_id) DO NOTHING
  `;
}

export async function pgPoolRandom(
  source_id: string,
  pool_key: string
): Promise<PgPoolItemRow | null> {
  await ensureTable();
  const normalized = normalizeKeyString(pool_key);
  const kh = keyHash(normalized);
  const rows = (await sql/*sql*/`
    SELECT item_id, item, encoding, content_type, created_at
      FROM pool_entries
     WHERE source_id = ${source_id} AND key_hash = ${kh}
     ORDER BY random()
     LIMIT 1
  `) as unknown as Array<PgPoolItemRow & { item: unknown }>;
  const row = rows[0];
  if (!row) return null;
  const item = parseMaybeObj<unknown>(row.item);
  if (item === null) return null;
  return {
    item_id: row.item_id,
    item,
    encoding: row.encoding,
    content_type: row.content_type ?? null,
    created_at: new Date(row.created_at).toISOString(),
  };
}

export async function pgPoolGetItemById(
  source_id: string,
  pool_key: string,
  item_id: string
): Promise<PgPoolItemRow | null> {
  await ensureTable();
  const normalized = normalizeKeyString(pool_key);
  const kh = keyHash(normalized);
  const rows = (await sql/*sql*/`
    SELECT item_id, item, encoding, content_type, created_at
      FROM pool_entries
     WHERE source_id = ${source_id} AND key_hash = ${kh} AND item_id = ${item_id}
     LIMIT 1
  `) as unknown as Array<PgPoolItemRow & { item: unknown }>;
  const row = rows[0];
  if (!row) return null;
  const item = parseMaybeObj<unknown>(row.item);
  if (item === null) return null;
  return {
    item_id: row.item_id,
    item,
    encoding: row.encoding,
    content_type: row.content_type ?? null,
    created_at: new Date(row.created_at).toISOString(),
  };
}
