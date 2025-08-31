// netlify/lib/cache.mts
import { redis } from './redis.mjs';
import { keyHash, normalizeKeyString, redisKeyCache } from './key.mjs';
import type { CacheEntry, CacheMeta } from './types.mjs';
import { pgGetCacheEntry, pgSetCacheEntry, pgDelCacheEntry } from './cache-pg.mjs';

function nowISO(): string {
  return new Date().toISOString();
}

export function isStale(meta: Pick<CacheMeta, 'expires_at'>): boolean {
  if (!meta.expires_at) return false;
  return Date.now() >= Date.parse(meta.expires_at);
}

export async function getCacheEntry<T = unknown>(source_id: string, key: string): Promise<CacheEntry<T> | null> {
  const normalized = normalizeKeyString(key);
  const k = redisKeyCache(source_id, keyHash(normalized));
  const val = await redis.get<CacheEntry<T>>(k);
  if (val) return val;
  // Redis 未命中 → 尝试从 Postgres 读取并回填 Redis
  const fromPg = await pgGetCacheEntry<T>(source_id, key);
  if (!fromPg) return null;
  // 计算剩余 TTL；若已过期则回填一个短 TTL，避免频繁读 PG
  const ttl = ttlFromExpiresAt(fromPg.meta?.expires_at);
  try {
    await setCacheEntry<T>(source_id, key, fromPg, { ttl_s: ttl, persistToPg: false });
  } catch {}
  return fromPg;
}

export interface SetCacheEntryOptions {
  ttl_s?: number; // 覆盖 TTL；默认写入 meta.ttl_s
  persistToPg?: boolean; // 是否持久化到 Postgres，默认 true
}

export async function setCacheEntry<T = unknown>(
  source_id: string,
  key: string,
  entry: CacheEntry<T>,
  opts: SetCacheEntryOptions = {}
): Promise<void> {
  const normalized = normalizeKeyString(key);
  const k = redisKeyCache(source_id, keyHash(normalized));
  const ttl = opts.ttl_s ?? entry?.meta?.ttl_s ?? 0;
  const copy: CacheEntry<T> = {
    ...entry,
    meta: {
      ...entry.meta,
      source_id,
      key: normalized,
      cached_at: nowISO(),
      stale: isStale(entry.meta),
    },
  };
  if (ttl && ttl > 0) {
    await redis.set(k, copy, { ex: ttl });
  } else {
    await redis.set(k, copy);
  }
  // 默认写入 Postgres（写透）；可通过 opts.persistToPg 关闭
  const persist = opts.persistToPg !== false;
  if (persist) {
    await pgSetCacheEntry(source_id, key, copy);
  }
}

export async function delCacheEntry(source_id: string, key: string): Promise<number> {
  const normalized = normalizeKeyString(key);
  const k = redisKeyCache(source_id, keyHash(normalized));
  const [n, m] = await Promise.all([redis.del(k), pgDelCacheEntry(source_id, key)]);
  return Number(n ?? 0) + Number(m ?? 0);
}

export function computeExpiresAt(ttl_s: number): string | null {
  if (!ttl_s || ttl_s <= 0) return null;
  return new Date(Date.now() + ttl_s * 1000).toISOString();
}

// 根据 expires_at 计算剩余 TTL；无过期则返回 0；若已过期回填一个短 TTL（60s）
function ttlFromExpiresAt(expires_at?: string | null): number {
  if (!expires_at) return 0;
  const remain = Math.floor((Date.parse(expires_at) - Date.now()) / 1000);
  return remain > 0 ? remain : 60;
}

