// netlify/lib/key.mts
import { createHash } from 'node:crypto';

function get(obj: any, path: string): any {
  return path.split('.').reduce((acc: any, k: string) => (acc == null ? undefined : acc[k]), obj);
}

export function templateKey(template: string, params: Record<string, any>): string {
  const s = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, p1) => {
    const v = get(params, p1);
    return v == null ? '' : String(v);
  });
  return normalizeKeyString(s);
}

export function normalizeKeyString(key: string): string {
  if (!key) return '/';
  let s = String(key).trim();
  // 如果是 URL 编码的 key，尽量解码一次；失败则忽略
  try {
    s = decodeURIComponent(s);
  } catch {}
  // 统一前缀斜杠，去掉多余斜杠
  if (!s.startsWith('/')) s = '/' + s;
  // 折叠连续斜杠为单个斜杠
  s = s.replace(/\/{2,}/g, '/');
  // 去掉尾部斜杠（根路径除外）
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

export function keyHash(key: string): string {
  return createHash('sha1').update(key).digest('hex');
}

export function redisKeyCache(source_id: string, key_hash: string): string {
  return `uc:cache:${source_id}:${key_hash}`;
}

export function redisKeyDedup(source_id: string, key_hash: string): string {
  return `uc:dedup:${source_id}:${key_hash}`;
}

export function redisKeyIdemp(hash: string): string {
  return `uc:idemp:${hash}`;
}

export function redisKeyHot(source_id: string, key_hash: string): string {
  return `uc:hot:${source_id}:${key_hash}`;
}

export function redisKeyHotCooldown(source_id: string, key_hash: string): string {
  return `uc:hotcd:${source_id}:${key_hash}`;
}

export function redisQueueKey(source_id: string): string {
  return `uc:q:${source_id}`;
}

// Pool keys for list/pool support
export function redisKeyPoolIds(source_id: string, key_hash: string): string {
  return `uc:pool:ids:${source_id}:${key_hash}`;
}

export function redisKeyPoolItem(source_id: string, key_hash: string, item_id: string): string {
  return `uc:pool:item:${source_id}:${key_hash}:${item_id}`;
}

// 仅用于池模式：
// - 解码并规范化路径
// - 保留业务查询参数，但移除用于去重的临时参数 i（由调度/预取附加）
// - 忽略片段（#...）
export function sanitizePoolKey(raw: string): string {
  try {
    const normalized = normalizeKeyString(String(raw ?? ''));
    // 使用虚拟基准解析，方便拆出 pathname 与 query
    const u = new URL(normalized, 'http://uc.local');
    // 移除用于去重的 nonce 参数
    u.searchParams.delete('i');
    const qs = u.searchParams.toString();
    const path = u.pathname || '/';
    return qs ? `${path}?${qs}` : path;
  } catch {
    // 兜底：至少保持规范的路径前缀
    return normalizeKeyString(String(raw ?? ''));
  }
}
