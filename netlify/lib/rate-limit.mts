// netlify/lib/rate-limit.mts
// Simplified fixed-window rate limiting: per-minute counter (per_minute + burst)
// For more accuracy, switch to a token bucket or sliding window.
import { redis } from './redis.mjs';
import type { RateLimitDecision } from './types.mjs';

export interface RateLimitConfig {
  per_minute: number;
  burst?: number;
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function windowKey(source_id: string, d = new Date()): string {
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const hh = pad(d.getUTCHours());
  const mm = pad(d.getUTCMinutes());
  return `uc:rl:${source_id}:${y}${m}${day}${hh}${mm}`;
}

function nextMinuteResetAt(d = new Date()): string {
  const next = new Date(d.getTime());
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(next.getUTCMinutes() + 1);
  return next.toISOString();
}

export async function acquire(source_id: string, cfg: RateLimitConfig): Promise<RateLimitDecision> {
  const limit = Math.max(0, cfg?.per_minute ?? 0) + Math.max(0, cfg?.burst ?? 0);
  const k = windowKey(source_id);

  // Increment this minute's counter; on first increment set TTL (2-minute buffer to cover cross-window calls)
  const current = await redis.incr(k);
  if (current === 1) {
    // 120s expiry to ensure cleanup after the window ends
    await redis.expire(k, 120);
  }

  const allowed = current <= limit;
  const remaining = Math.max(0, limit - current);
  const reset_at = nextMinuteResetAt();
  return { allowed, limit, remaining, reset_at };
}
