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
    // 仅在未过期时才考虑提升 TTL
    const stale = isStale({ expires_at: val.meta?.expires_at } as any);
    if (!stale) {
      // 异步尝试提升 TTL（命中才计数）；忽略异常
      maybeBumpTtl(source_id, normalized).catch(() => {});
    }
    return val;
  }
  // Redis 未命中 → 尝试从 Postgres 读取并回填 Redis
  const fromPg = await pgGetCacheEntry<T>(source_id, key);
  if (!fromPg) return null;
  // 计算剩余 TTL；若已过期则回填一个短 TTL，避免频繁读 PG
  const ttl = ttlFromExpiresAt(fromPg.meta?.expires_at);
  try {
    await setCacheEntry<T>(source_id, key, fromPg, { ttl_s: ttl, persistToPg: false });
  } catch {}
  // 回填后若未过期，再计数一次（便于刚从 PG 恢复的热点尽快提升 TTL）
  const stale = isStale({ expires_at: fromPg.meta?.expires_at } as any);
  if (!stale) {
    maybeBumpTtl(source_id, normalized).catch(() => {});
  }
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


// 动态 TTL 提升：当某个 key 在时间窗口内被频繁命中时，延长其 Redis TTL（不修改 PG 持久层 nor meta.expires_at）
export interface TtlBumpOptions {
  window_s: number; // 计数窗口秒数
  threshold: number; // 窗口内命中次数阈值，达到后触发 TTL 提升
  delta_s: number; // 每次提升增加的秒数
  max_ttl_s: number; // TTL 上限（防止无限增长）
  cooldown_s: number; // 提升后的冷却期，在冷却内不重复提升
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
  // 环境参数（可覆盖）
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

  // 冷却中则跳过
  try {
    const cdTtl = await redis.ttl(cdKey);
    if (typeof cdTtl === 'number' && cdTtl > 0) {
      return { bumped: false, reason: 'cooldown' };
    }
  } catch {}

  // 命中计数 + 过期时间形成近似滑动窗口（固定窗口 + 自然过期）
  let count = 0;
  try {
    count = (await redis.incr(hitsKey)) as unknown as number;
    if (count === 1) {
      await redis.expire(hitsKey, window_s);
    }
  } catch {
    // 计数失败不影响主流程
    return { bumped: false, reason: 'counter_error' };
  }

  if (count < threshold) {
    return { bumped: false, reason: 'below_threshold', count };
  }

  try {
    // 触发一次后进入冷却，避免抖动
    await redis.set(cdKey, '1', { ex: cooldown_s });

    // 获取当前 TTL，仅当已有 TTL (>0) 时才可提升；-1(无过期)或-2(不存在)则跳过
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

