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

// Mock sources-pg to control supports_pool behavior for tests that need it
const sourcesPgMock = {
  getSourceSupportsPool: vi.fn(),
};
vi.mock('../../lib/sources-pg.mjs', () => sourcesPgMock);

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

  it('enforces pool-only when source supports pool: 202 with task on miss', async () => {
    // Pool miss
    poolMock.poolRandom.mockResolvedValueOnce(null);
    // supports_pool = true
    sourcesPgMock.getSourceSupportsPool.mockResolvedValueOnce(true);
    // enqueue to pool job
    queueMock.enqueueRefresh.mockResolvedValueOnce({ enqueued: true, jobId: 't2' });

    const mod = await import('../cache-get.mts');
    const handler = mod.default as (req: Request, ctx: any) => Promise<Response>;

    const req = new Request('https://example.com/api/v1/cache/quotes/%2Fquotes');
    const ctx = { params: { source_id: 'quotes', key: '/quotes' } };

    const res = await handler(req, ctx);
    expect(res.status).toBe(202);
    expect(res.headers.get('X-UC-Served-From')).toBe('pool-none');
    const body = await res.json();
    expect(body.pool).toBe(true);
    expect(queueMock.enqueueRefresh).toHaveBeenCalled();
    const arg = (queueMock.enqueueRefresh as any).mock.calls.pop()?.[0];
    expect(String(arg?.key)).toMatch(/^\/pool:\/quotes\?i=|^\/pool:\/quotes&i=/);
  });

  it('returns 404 on cache-only when source supports pool and pool miss', async () => {
    poolMock.poolRandom.mockResolvedValueOnce(null);
    sourcesPgMock.getSourceSupportsPool.mockResolvedValueOnce(true);

    const mod = await import('../cache-get.mts');
    const handler = mod.default as (req: Request, ctx: any) => Promise<Response>;

    const req = new Request('https://example.com/api/v1/cache/quotes/%2Fquotes', {
      headers: { 'X-UC-Cache-Only': 'true' },
    });
    const ctx = { params: { source_id: 'quotes', key: '/quotes' } };

    const res = await handler(req, ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get('X-UC-Served-From')).toBe('pool-none');
  });
});
