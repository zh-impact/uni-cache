import type { Config, Context } from '@netlify/functions';
import { sql } from '../lib/db.mjs';
import { redis } from '../lib/redis.mjs';
import { redisQueueKey } from '../lib/key.mjs';
import { acquire } from '../lib/rate-limit.mjs';
import { getCacheEntry, setCacheEntry, computeExpiresAt } from '../lib/cache.mjs';
import type { CacheDataEncoding, CacheEntry, RefreshJob } from '../lib/types.mjs';
import { runOnce } from '../lib/runner.mjs';

const MAX_PER_SOURCE = 20; // 每源单次最多处理作业数
const TIME_BUDGET_MS = 8_000; // 单次执行最大时间预算（毫秒）
const MAX_ATTEMPTS = 3; // 瞬态错误重试的最大尝试次数（通过队列回推实现）

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

async function pickDataAndEncoding(
  res: Response
): Promise<{ data: any; encoding: CacheDataEncoding; contentType: string | null }> {
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
  // Node 环境可用 Buffer
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

export default async (req: Request, _context: Context) => {
  // Netlify Scheduled Functions 会传递 JSON 事件体（包含 next_run 等），未提供也不影响
  try {
    const evt = await req.json().catch(() => ({} as any));
    if (evt?.next_run) console.log('scheduled-refresh next_run:', evt.next_run);
  } catch {}

  const summary = await runOnce({});
  return new Response(JSON.stringify({ endpoint: 'scheduled-refresh', ...summary }, null, 2), {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
};

export const config: Config = {
  // Every 5 minutes; adjust per source strategies as needed.
  schedule: '*/5 * * * *',
};
