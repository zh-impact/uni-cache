// netlify/lib/cache.mts
import { redis } from './redis.mjs';
import { keyHash, normalizeKeyString, redisKeyCache, redisKeyHot, redisKeyHotCooldown } from './key.mjs';
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
  if (val) {
    // Only consider bumping TTL when not expired
    const stale = isStale({ expires_at: val.meta?.expires_at } as any);
    if (!stale) {
      // Asynchronously attempt to bump TTL (only count on hits); ignore errors
      maybeBumpTtl(source_id, normalized).catch(() => {});
    }
    return val;
  }
  // Redis miss → try reading from Postgres and backfill Redis
  const fromPg = await pgGetCacheEntry<T>(source_id, key);
  if (!fromPg) return null;
  // Compute remaining TTL; if already expired, backfill with a short TTL to avoid frequent PG reads
  const ttl = ttlFromExpiresAt(fromPg.meta?.expires_at);
  try {
    await setCacheEntry<T>(source_id, key, fromPg, { ttl_s: ttl, persistToPg: false });
  } catch {}
  // After backfill, if not expired, increment once more (so newly recovered hot keys from PG can bump TTL sooner)
  const stale = isStale({ expires_at: fromPg.meta?.expires_at } as any);
  if (!stale) {
    maybeBumpTtl(source_id, normalized).catch(() => {});
  }
  return fromPg;
}

export interface SetCacheEntryOptions {
  ttl_s?: number; // Override TTL; defaults to meta.ttl_s
  persistToPg?: boolean; // Whether to persist to Postgres; default true
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
  // Write-through to Postgres by default; can be disabled via opts.persistToPg
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

// Compute remaining TTL from expires_at; return 0 if no expiry; if expired, use a short backfill TTL (60s)
function ttlFromExpiresAt(expires_at?: string | null): number {
  if (!expires_at) return 0;
  const remain = Math.floor((Date.parse(expires_at) - Date.now()) / 1000);
  return remain > 0 ? remain : 60;
}


// Dynamic TTL bump: when a key is frequently hit within a time window, extend its Redis TTL (does not change PG storage nor meta.expires_at)
export interface TtlBumpOptions {
  window_s: number; // Counting window in seconds
  threshold: number; // Hit count threshold within the window to trigger TTL bump
  delta_s: number; // Seconds to add on each bump
  max_ttl_s: number; // TTL upper bound (prevents unbounded growth)
  cooldown_s: number; // Cooldown after a bump; do not re-bump during cooldown
}

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  const n = raw == null ? NaN : Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

export async function maybeBumpTtl(
  source_id: string,
  key: string,
  opts: Partial<TtlBumpOptions> = {}
): Promise<{ bumped: boolean; newTtl?: number; reason?: string; count?: number }> {
  // Environment parameters (overridable)
  const window_s = opts.window_s ?? envInt('UC_TTL_BUMP_WINDOW_S', 60);
  const threshold = opts.threshold ?? envInt('UC_TTL_BUMP_THRESHOLD', 20);
  const delta_s = opts.delta_s ?? envInt('UC_TTL_BUMP_DELTA_S', 60);
  const max_ttl_s = opts.max_ttl_s ?? envInt('UC_TTL_BUMP_MAX_TTL_S', 3600);
  const cooldown_s = opts.cooldown_s ?? envInt('UC_TTL_BUMP_COOLDOWN_S', 120);

  if (threshold <= 0 || delta_s <= 0 || max_ttl_s <= 0 || window_s <= 0) {
    return { bumped: false, reason: 'disabled' };
  }

  const normalized = normalizeKeyString(key);
  const kh = keyHash(normalized);
  const cacheKey = redisKeyCache(source_id, kh);
  const hitsKey = redisKeyHot(source_id, kh);
  const cdKey = redisKeyHotCooldown(source_id, kh);

  // Skip if in cooldown
  try {
    const cdTtl = await redis.ttl(cdKey);
    if (typeof cdTtl === 'number' && cdTtl > 0) {
      return { bumped: false, reason: 'cooldown' };
    }
  } catch {}

  // Hit counter + expiry approximates a sliding window (fixed window + natural expiration)
  let count = 0;
  try {
    count = (await redis.incr(hitsKey)) as unknown as number;
    if (count === 1) {
      await redis.expire(hitsKey, window_s);
    }
  } catch {
    // Counter failure does not affect the main flow
    return { bumped: false, reason: 'counter_error' };
  }

  if (count < threshold) {
    return { bumped: false, reason: 'below_threshold', count };
  }

  try {
    // Enter cooldown after a bump to avoid thrashing
    await redis.set(cdKey, '1', { ex: cooldown_s });

    // Fetch current TTL; only bump if TTL (>0). Skip -1 (no expiry) or -2 (does not exist)
    const curTtl = (await redis.ttl(cacheKey)) as unknown as number;
    if (typeof curTtl !== 'number' || curTtl <= 0) {
      return { bumped: false, reason: 'no_ttl', count };
    }

    const newTtl = Math.min(curTtl + delta_s, max_ttl_s);
    if (newTtl > curTtl) {
      await redis.expire(cacheKey, newTtl);
      return { bumped: true, newTtl, count };
    }
    return { bumped: false, reason: 'ttl_capped', count };
  } catch {
    return { bumped: false, reason: 'bump_error', count };
  }
}

