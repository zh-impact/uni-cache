// netlify/lib/runner.mts
import { sql } from './db.mjs';
import { redis } from './redis.mjs';
import { redisQueueKey } from './key.mjs';
import { acquire } from './rate-limit.mjs';
import { getCacheEntry, setCacheEntry, computeExpiresAt } from './cache.mjs';
import type { CacheDataEncoding, CacheEntry, RefreshJob } from './types.mjs';

const DEFAULT_MAX_PER_SOURCE = 20; // 每源单次最多处理作业数
const DEFAULT_TIME_BUDGET_MS = 5_000; // 即时执行时间预算（毫秒）
const MAX_ATTEMPTS = 3; // 瞬态错误重试的最大尝试次数（通过队列回推实现）

export type RunSummary = {
  ok: true;
  processed_sources: number;
  per_source: Record<string, { dequeued: number; updated: number; not_modified: number; errors: number }>;
  duration_ms: number;
};

export interface RunOptions {
  source_id?: string | null;
  maxPerSource?: number;
  timeBudgetMs?: number;
}

type SourceRow = {
  id: string;
  base_url: string;
  default_headers: Record<string, string> | null;
  default_query: Record<string, string | number | boolean> | null;
  rate_limit: { per_minute?: number; burst?: number } | null;
  cache_ttl_s: number | null;
};

function ensureHeaders(obj: Record<string, any> | null | undefined): Record<string, string> {
  const h: Record<string, string> = {};
  if (!obj) return h;
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    h[k] = String(v);
  }
  return h;
}

function buildURL(base: string, path: string, q: Record<string, any> | null | undefined): string {
  // 组合 base_url 与 key（key 通常以 "/" 开头）
  const u = new URL(path, base);
  if (q) {
    for (const [k, v] of Object.entries(q)) {
      if (v == null) continue;
      if (!u.searchParams.has(k)) u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

async function pickDataAndEncoding(res: Response): Promise<{ data: any; encoding: CacheDataEncoding; contentType: string | null }> {
  const ct = res.headers.get('content-type');
  const cts = (ct || '').toLowerCase();
  if (cts.includes('application/json')) {
    try {
      const json = await res.json();
      return { data: json, encoding: 'json', contentType: ct };
    } catch {
      const txt = await res.text();
      return { data: txt, encoding: 'text', contentType: ct };
    }
  }
  if (cts.startsWith('text/')) {
    const txt = await res.text();
    return { data: txt, encoding: 'text', contentType: ct };
  }
  const ab = await res.arrayBuffer();
  const b64 = Buffer.from(ab).toString('base64');
  return { data: b64, encoding: 'base64', contentType: ct };
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 针对 5xx/429 和网络错误的轻量重试 + 超时；
// 非重试性状态（2xx/3xx/4xx except 429）直接返回响应。
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { attempts?: number; baseDelayMs?: number; timeoutMs?: number } = {}
): Promise<Response> {
  const attempts = Math.max(1, opts.attempts ?? 2);
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const timeoutMs = opts.timeoutMs ?? 2500;
  let lastErr: unknown;
  let lastRes: Response | undefined;

  for (let i = 1; i <= attempts; i++) {
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const t = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
    try {
      const res = await fetch(url, { ...init, signal: ac?.signal });
      lastRes = res;
      // 5xx 或 429 认为是可重试；其他状态直接返回
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`upstream status ${res.status}`);
      } else {
        if (t) clearTimeout(t as any);
        return res;
      }
    } catch (e) {
      lastErr = e;
    } finally {
      if (t) clearTimeout(t as any);
    }
    if (i < attempts) {
      const jitter = Math.floor(Math.random() * baseDelayMs);
      await sleep(baseDelayMs * i + jitter);
    }
  }
  if (lastRes) return lastRes;
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'fetch failed'));
}

// Neon 返回 JSON 列可能为 string，这里对字段做一次宽松解析
const parseMaybeObj = <T extends unknown,>(v: unknown): T | null => {
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
};

export async function runOnce(opts: RunOptions = {}): Promise<RunSummary> {
  const started = Date.now();
  const maxPerSource = Math.max(1, Math.floor(opts.maxPerSource ?? DEFAULT_MAX_PER_SOURCE));
  const timeBudgetMs = Math.max(500, Math.floor(opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS));

  const sources: SourceRow[] = opts.source_id
    ? ((await sql/*sql*/`SELECT id, base_url, default_headers, default_query, rate_limit, cache_ttl_s FROM sources WHERE id = ${opts.source_id} ORDER BY id`) as unknown as SourceRow[])
    : ((await sql/*sql*/`SELECT id, base_url, default_headers, default_query, rate_limit, cache_ttl_s FROM sources ORDER BY id`) as unknown as SourceRow[]);

  const perSource: Record<string, { dequeued: number; updated: number; not_modified: number; errors: number }> = {};
  console.log('sources:', sources);
  for (const src of sources) {
    perSource[src.id] = { dequeued: 0, updated: 0, not_modified: 0, errors: 0 };
    const qkey = redisQueueKey(src.id);

    const rlCfg = parseMaybeObj<{ per_minute?: number; burst?: number }>(src.rate_limit);
    const perMinute = Math.max(0, rlCfg?.per_minute ?? 5);
    const burst = Math.max(0, rlCfg?.burst ?? 0);

    for (let i = 0; i < maxPerSource; i++) {
      if (Date.now() - started > timeBudgetMs) break; // 时间预算兜底

      const raw = await redis.lpop<string>(qkey);
      if (!raw) break; // 队列空
      perSource[src.id].dequeued++;

      let job: RefreshJob | null = null;
      console.log('popping job:', raw);
      try {
        job = JSON.parse(raw) as RefreshJob;
      } catch (e) {
        console.warn('invalid job payload, dropped:', e);
        continue;
      }
      if (!job?.key) continue;

      // 限速（简单固定窗）：仅在取到作业后扣额度；若不允许，放回队尾并停止当前源
      const rl = await acquire(src.id, { per_minute: perMinute, burst });
      if (!rl.allowed) {
        await redis.rpush(qkey, raw);
        break;
      }

      try {
        // 条件请求：若已有缓存则携带 ETag/If-Modified-Since
        const prev: CacheEntry | null = await getCacheEntry(src.id, job.key);
        const headers = ensureHeaders(parseMaybeObj<Record<string, string>>(src.default_headers));
        if (prev?.meta?.etag) headers['If-None-Match'] = prev.meta.etag;
        else if (prev?.meta?.last_modified) headers['If-Modified-Since'] = prev.meta.last_modified;

        const url = buildURL(src.base_url, job.key, parseMaybeObj<Record<string, any>>(src.default_query));
        const res = await fetchWithRetry(url, { method: 'GET', headers }, { attempts: 2, baseDelayMs: 200, timeoutMs: 2500 });

        if (res.status === 304 && prev) {
          // 未修改：续期 TTL，并更新 cached_at
          const ttl_s = Number(src.cache_ttl_s ?? prev.meta.ttl_s ?? 600);
          const entry: CacheEntry = {
            data: prev.data,
            meta: {
              ...prev.meta,
              expires_at: computeExpiresAt(ttl_s),
              ttl_s,
            },
          };
          await setCacheEntry(src.id, job.key, entry, { ttl_s });
          perSource[src.id].not_modified++;
          continue;
        }

        if (!res.ok) {
          if (res.status === 429 || res.status === 502 || res.status === 503) {
            // 视为瞬态错误：将作业放回队列尾部（增加 attempts），稍后重试
            const nextAttempts = (job.attempts ?? 0) + 1;
            if (nextAttempts <= MAX_ATTEMPTS) {
              const requeue = { ...job, attempts: nextAttempts } as RefreshJob;
              await redis.rpush(qkey, JSON.stringify(requeue));
            }
          }
          perSource[src.id].errors++;
          console.warn('origin non-2xx', { source_id: src.id, key: job.key, status: res.status });
          continue;
        }

        const { data, encoding, contentType } = await pickDataAndEncoding(res);
        const etag = res.headers.get('etag');
        const lastMod = res.headers.get('last-modified');
        const ttl_s = Number(src.cache_ttl_s ?? 600);
        const entry: CacheEntry = {
          data,
          meta: {
            source_id: src.id,
            key: job.key,
            cached_at: new Date().toISOString(), // 将被 setCacheEntry 覆盖为当前时间
            expires_at: computeExpiresAt(ttl_s),
            stale: false, // 将由 setCacheEntry 重新计算
            ttl_s,
            etag: etag ?? null,
            last_modified: lastMod ?? null,
            origin_status: res.status,
            content_type: contentType ?? null,
            data_encoding: encoding,
          },
        };
        await setCacheEntry(src.id, job.key, entry, { ttl_s });
        perSource[src.id].updated++;
      } catch (e) {
        // 可能是网络错误/超时：按瞬态处理，回推队列（带 attempts 上限）
        try {
          const nextAttempts = (job?.attempts ?? 0) + 1;
          if (job?.key && nextAttempts <= MAX_ATTEMPTS) {
            const requeue = { ...job, attempts: nextAttempts } as RefreshJob;
            await redis.rpush(qkey, JSON.stringify(requeue));
          }
        } catch {}
        perSource[src.id].errors++;
        console.error('refresh error', { source_id: src.id, key: job?.key, err: String(e) });
      }
    }
  }

  return {
    ok: true,
    processed_sources: Object.keys(perSource).length,
    per_source: perSource,
    duration_ms: Date.now() - started,
  };
}
