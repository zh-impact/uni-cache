import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock pool and queue libs BEFORE importing the function under test
const poolMock = {
  poolRandom: vi.fn(),
};
vi.mock('../../lib/pool.mjs', () => poolMock);

const queueMock = {
  enqueueRefresh: vi.fn(),
};
vi.mock('../../lib/queue.mjs', () => queueMock);

// Avoid importing real cache.mjs which would initialize Redis client
vi.mock('../../lib/cache.mjs', () => ({
  getCacheEntry: vi.fn(),
  isStale: () => false,
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('cache-get pool mode', () => {
  it('returns pool item with headers and meta', async () => {
    poolMock.poolRandom.mockResolvedValueOnce({
      item_id: 'id-redis',
      data: { q: 'hello' },
      encoding: 'json',
      content_type: 'application/json',
      from: 'redis',
    });

    const mod = await import('../cache-get.mts');
    const handler = mod.default as (req: Request, ctx: any) => Promise<Response>;

    const req = new Request('https://example.com/api/v1/cache/quotes/%2Fquotes');
    const ctx = { params: { source_id: 'quotes', key: '/quotes' } };

    const res = await handler(req, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).toBe('id-redis');
    expect(res.headers.get('X-UC-Served-From')).toBe('pool-redis');

    const body = await res.json();
    expect(body.meta).toMatchObject({ pool: true, item_id: 'id-redis', served_from: 'pool-redis' });
    expect(body.data).toEqual({ q: 'hello' });
  });

  it('returns 304 when If-None-Match matches item_id', async () => {
    poolMock.poolRandom.mockResolvedValueOnce({
      item_id: 'id-304',
      data: { any: 1 },
      encoding: 'json',
      content_type: 'application/json',
      from: 'pg',
    });

    const mod = await import('../cache-get.mts');
    const handler = mod.default as (req: Request, ctx: any) => Promise<Response>;

    const req = new Request('https://example.com/api/v1/cache/quotes/%2Fquotes', {
      headers: { 'If-None-Match': 'foo, id-304' },
    });
    const ctx = { params: { source_id: 'quotes', key: '/quotes' } };

    const res = await handler(req, ctx);
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe('id-304');
  });

  it('enqueues async pool refresh when bypass header present', async () => {
    poolMock.poolRandom.mockResolvedValueOnce({
      item_id: 'id-bp',
      data: { ok: true },
      encoding: 'json',
      content_type: 'application/json',
      from: 'redis',
    });
    queueMock.enqueueRefresh.mockResolvedValueOnce({ enqueued: true, jobId: 't1' });

    const mod = await import('../cache-get.mts');
    const handler = mod.default as (req: Request, ctx: any) => Promise<Response>;

    const req = new Request('https://example.com/api/v1/cache/quotes/%2Fquotes', {
      headers: { 'X-UC-Bypass-Cache': 'true' },
    });
    const ctx = { params: { source_id: 'quotes', key: '/quotes' } };

    const res = await handler(req, ctx);
    expect(res.status).toBe(200);
    // ensure enqueue called with a pool job key prefix
    expect(queueMock.enqueueRefresh).toHaveBeenCalled();
    const calls = (queueMock.enqueueRefresh as any).mock.calls as any[];
    const arg = calls[calls.length - 1]?.[0];
    expect(arg?.source_id).toBe('quotes');
    expect(String(arg?.key)).toMatch(/^\/pool:\/quotes\?i=/);
  });
});
