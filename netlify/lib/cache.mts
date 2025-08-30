// netlify/lib/cache.mts
import { redis } from './redis.mjs';
import { keyHash, normalizeKeyString, redisKeyCache } from './key.mjs';
import type { CacheEntry, CacheMeta } from './types.mjs';

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
  return val ?? null;
}

export interface SetCacheEntryOptions {
  ttl_s?: number; // 覆盖 TTL；默认写入 meta.ttl_s
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
}

export async function delCacheEntry(source_id: string, key: string): Promise<number> {
  const normalized = normalizeKeyString(key);
  const k = redisKeyCache(source_id, keyHash(normalized));
  const n = await redis.del(k);
  return Number(n ?? 0);
}

export function computeExpiresAt(ttl_s: number): string | null {
  if (!ttl_s || ttl_s <= 0) return null;
  return new Date(Date.now() + ttl_s * 1000).toISOString();
}
