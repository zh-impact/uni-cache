// netlify/lib/types.mts
// 统一的类型定义，覆盖 CacheEntry / Job / RateLimit 等

export type CacheDataEncoding = 'json' | 'text' | 'base64';

export interface CacheMeta {
  source_id: string;
  key: string; // 规范化后的 key（例如：/weather/Shanghai）
  cached_at: string; // ISO time
  expires_at: string | null; // ISO time or null（无过期）
  stale: boolean; // 是否已过期（服务端视角）
  ttl_s: number; // TTL 秒（用于重新设置/延长）
  etag?: string | null;
  last_modified?: string | null;
  origin_status?: number | null;
  content_type?: string | null; // e.g. application/json, image/png
  data_encoding: CacheDataEncoding; // json | text | base64
}

export interface CacheEntry<TData = unknown> {
  data: TData | string | null; // json 对象、纯文本或 base64 编码
  meta: CacheMeta;
}

export type JobPriority = 'low' | 'normal' | 'high';

export interface RefreshJob {
  id?: string; // 由队列层生成
  source_id: string;
  key: string; // 规范化后的 key
  priority?: JobPriority;
  enqueued_at?: string; // ISO time
}

export interface EnqueueResult {
  enqueued: boolean;
  jobId?: string;
  reason?: 'duplicate' | 'idempotent_reject' | 'invalid';
}

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  reset_at: string; // ISO time
}
