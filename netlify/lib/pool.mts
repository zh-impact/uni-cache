// netlify/lib/pool.mts
import { redis } from './redis.mjs';
import { keyHash, normalizeKeyString, redisKeyPoolIds, redisKeyPoolItem } from './key.mjs';
import { pgPoolAddItem, pgPoolGetItemById, pgPoolRandom } from './pool-pg.mjs';
import type { CacheDataEncoding } from './types.mjs';
import { createHash } from 'node:crypto';

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}

function envInt(name: string, def: number): number {
  const raw = process.env[name];
  const n = raw == null ? NaN : Number.parseInt(String(raw), 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const POOL_ITEM_TTL_S = envInt('UC_POOL_ITEM_TTL_S', 24 * 60 * 60); // 默认 24h 的 Redis 热缓存

export type PoolAddPayload = {
  data: any;
  encoding: CacheDataEncoding;
  content_type?: string | null;
};

export async function poolAddItem(source_id: string, pool_key: string, payload: PoolAddPayload): Promise<{ item_id: string } | null> {
  const normalized = normalizeKeyString(pool_key);
  const kh = keyHash(normalized);

  // 基于编码+内容计算稳定 item_id；json 直接 JSON.stringify（不稳定顺序可接受，首版简化）
  let base: string;
  try {
    if (payload.encoding === 'json') base = `json:${JSON.stringify(payload.data)}`;
    else if (payload.encoding === 'text') base = `text:${String(payload.data ?? '')}`;
    else base = `b64:${String(payload.data ?? '')}`;
  } catch {
    base = `raw:${String(payload.data ?? '')}`;
  }
  const item_id = sha1(base);

  // 写入 PG（去重由 PK 保护）
  await pgPoolAddItem(source_id, normalized, {
    item_id,
    item: payload.data,
    encoding: payload.encoding,
    content_type: payload.content_type ?? null,
  });

  // 写入 Redis：集合 + 具体条目
  const idsKey = redisKeyPoolIds(source_id, kh);
  const itemKey = redisKeyPoolItem(source_id, kh, item_id);
  try {
    await redis.sadd(idsKey, item_id);
  } catch {}
  try {
    if (POOL_ITEM_TTL_S > 0) await redis.set(itemKey, { data: payload.data, encoding: payload.encoding, content_type: payload.content_type ?? null }, { ex: POOL_ITEM_TTL_S });
    else await redis.set(itemKey, { data: payload.data, encoding: payload.encoding, content_type: payload.content_type ?? null });
  } catch {}

  return { item_id };
}

export async function poolRandom(
  source_id: string,
  pool_key: string
): Promise<{ item_id: string; data: any; encoding: CacheDataEncoding; content_type: string | null; from: 'redis' | 'pg'; created_at?: string } | null> {
  const normalized = normalizeKeyString(pool_key);
  const kh = keyHash(normalized);
  const idsKey = redisKeyPoolIds(source_id, kh);

  try {
    const id = (await redis.srandmember(idsKey)) as unknown as string | null;
    if (id) {
      const itemKey = redisKeyPoolItem(source_id, kh, id);
      const obj = (await redis.get<{ data: any; encoding: CacheDataEncoding; content_type: string | null }>(itemKey)) || null;
      if (obj) return { item_id: id, data: obj.data, encoding: obj.encoding, content_type: obj.content_type ?? null, from: 'redis' };
      // Redis 未命中具体条目 → 回 PG 再回填
      const row = await pgPoolGetItemById(source_id, normalized, id);
      if (row) {
        try {
          const itemKey2 = redisKeyPoolItem(source_id, kh, row.item_id);
          if (POOL_ITEM_TTL_S > 0)
            await redis.set(itemKey2, { data: row.item, encoding: row.encoding as CacheDataEncoding, content_type: row.content_type ?? null }, { ex: POOL_ITEM_TTL_S });
          else await redis.set(itemKey2, { data: row.item, encoding: row.encoding as CacheDataEncoding, content_type: row.content_type ?? null });
        } catch {}
        return {
          item_id: row.item_id,
          data: row.item,
          encoding: row.encoding as CacheDataEncoding,
          content_type: row.content_type ?? null,
          created_at: row.created_at,
          from: 'pg',
        };
      }
    }
  } catch {}

  // Redis 集合为空或不存在 → 直接从 PG 随机
  const row = await pgPoolRandom(source_id, normalized);
  if (!row) return null;
  // 回填 Redis：加入集合 + 条目
  try {
    await redis.sadd(idsKey, row.item_id);
  } catch {}
  try {
    const itemKey = redisKeyPoolItem(source_id, kh, row.item_id);
    if (POOL_ITEM_TTL_S > 0)
      await redis.set(itemKey, { data: row.item, encoding: row.encoding as CacheDataEncoding, content_type: row.content_type ?? null }, { ex: POOL_ITEM_TTL_S });
    else await redis.set(itemKey, { data: row.item, encoding: row.encoding as CacheDataEncoding, content_type: row.content_type ?? null });
  } catch {}
  return {
    item_id: row.item_id,
    data: row.item,
    encoding: row.encoding as CacheDataEncoding,
    content_type: row.content_type ?? null,
    created_at: row.created_at,
    from: 'pg',
  };
}
