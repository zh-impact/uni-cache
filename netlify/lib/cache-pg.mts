// netlify/lib/cache-pg.mts
import { sql } from './db.mjs';
import { keyHash, normalizeKeyString } from './key.mjs';
import type { CacheEntry } from './types.mjs';

// 轻量 isStale，避免依赖 cache.mts 造成循环引用
function isStale(expires_at: string | null | undefined): boolean {
  if (!expires_at) return false;
  return Date.now() >= Date.parse(expires_at);
}

// Neon：确保表存在（进程内只执行一次）
let _ensurePromise: Promise<void> | null = null;
async function ensureTable() {
  if (_ensurePromise) return _ensurePromise;
  _ensurePromise = (async () => {
    await sql/*sql*/`
      CREATE TABLE IF NOT EXISTS cache_entries (
        source_id     TEXT NOT NULL,
        key           TEXT NOT NULL,
        key_hash      TEXT NOT NULL,
        entry         JSONB NOT NULL,
        etag          TEXT,
        last_modified TEXT,
        origin_status INT,
        content_type  TEXT,
        data_encoding TEXT NOT NULL,
        cached_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        expires_at    TIMESTAMPTZ NULL,
        ttl_s         INT NOT NULL DEFAULT 0,
        PRIMARY KEY (source_id, key_hash)
      )
    `;
    // 辅助索引：按 source_id + key 列表/查询
    await sql/*sql*/`
      CREATE INDEX IF NOT EXISTS cache_entries_source_key_idx
      ON cache_entries(source_id, key)
    `;
  })();
  return _ensurePromise;
}

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

export async function pgGetCacheEntry<T = unknown>(source_id: string, key: string): Promise<CacheEntry<T> | null> {
  await ensureTable();
  const normalized = normalizeKeyString(key);
  const kh = keyHash(normalized);
  const rows = (await sql/*sql*/`
    SELECT entry FROM cache_entries
     WHERE source_id = ${source_id} AND key_hash = ${kh}
     LIMIT 1
  `) as unknown as Array<{ entry: unknown }>;
  const row = rows[0];
  if (!row) return null;
  const entry = parseMaybeObj<CacheEntry<T>>(row.entry);
  if (!entry) return null;
  // 纠正关键字段与 stale
  entry.meta = {
    ...entry.meta,
    source_id,
    key: normalized,
    stale: isStale(entry.meta?.expires_at ?? null),
  } as any;
  return entry;
}

export async function pgSetCacheEntry<T = unknown>(source_id: string, key: string, entry: CacheEntry<T>): Promise<void> {
  await ensureTable();
  const normalized = normalizeKeyString(key);
  const kh = keyHash(normalized);
  const meta = entry.meta || ({} as any);
  const entryJson = JSON.stringify(entry);
  await sql/*sql*/`
    INSERT INTO cache_entries (
      source_id, key, key_hash, entry,
      etag, last_modified, origin_status, content_type,
      data_encoding, cached_at, expires_at, ttl_s
    ) VALUES (
      ${source_id}, ${normalized}, ${kh}, ${entryJson}::jsonb,
      ${meta.etag ?? null}, ${meta.last_modified ?? null}, ${meta.origin_status ?? null}, ${meta.content_type ?? null},
      ${meta.data_encoding ?? 'json'}, ${meta.cached_at ?? new Date().toISOString()}, ${meta.expires_at ?? null}, ${Number(meta.ttl_s ?? 0)}
    )
    ON CONFLICT (source_id, key_hash) DO UPDATE SET
      key = EXCLUDED.key,
      entry = EXCLUDED.entry,
      etag = EXCLUDED.etag,
      last_modified = EXCLUDED.last_modified,
      origin_status = EXCLUDED.origin_status,
      content_type = EXCLUDED.content_type,
      data_encoding = EXCLUDED.data_encoding,
      cached_at = EXCLUDED.cached_at,
      expires_at = EXCLUDED.expires_at,
      ttl_s = EXCLUDED.ttl_s
  `;
}

export async function pgDelCacheEntry(source_id: string, key: string): Promise<number> {
  await ensureTable();
  const normalized = normalizeKeyString(key);
  const kh = keyHash(normalized);
  const res = (await sql/*sql*/`
    DELETE FROM cache_entries WHERE source_id = ${source_id} AND key_hash = ${kh}
  `) as unknown as { rowCount?: number } | Array<unknown>;
  // Neon serverless: DML may return an object with rowCount, but typings vary; be defensive
  return typeof (res as any)?.rowCount === 'number' ? Number((res as any).rowCount ?? 0) : 0;
}
