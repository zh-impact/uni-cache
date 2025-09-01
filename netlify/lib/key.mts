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
  // If the key is URL-encoded, try decoding once; ignore failures
  try {
    s = decodeURIComponent(s);
  } catch {}
  // Normalize leading slash and remove redundant slashes
  if (!s.startsWith('/')) s = '/' + s;
  // Collapse multiple slashes into a single slash
  s = s.replace(/\/{2,}/g, '/');
  // Remove trailing slash (except for root)
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

// For pool mode only:
// - Decode and normalize path
// - Keep business query params but remove transient dedupe param `i` (added by scheduler/prefetch)
// - Ignore fragments (#...)
export function sanitizePoolKey(raw: string): string {
  try {
    const normalized = normalizeKeyString(String(raw ?? ''));
    // Parse with a dummy base to easily extract pathname and query
    const u = new URL(normalized, 'http://uc.local');
    // Remove nonce param used for dedupe
    u.searchParams.delete('i');
    const qs = u.searchParams.toString();
    const path = u.pathname || '/';
    return qs ? `${path}?${qs}` : path;
  } catch {
    // Fallback: at least keep a normalized path prefix
    return normalizeKeyString(String(raw ?? ''));
  }
}
