import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

// Mocks (must be defined before importing the module under test)
const redisMock = {
  sadd: vi.fn(),
  set: vi.fn(),
  srandmember: vi.fn(),
  get: vi.fn(),
};
vi.mock('../redis.mjs', () => ({ redis: redisMock }));

const pgMock = {
  pgPoolAddItem: vi.fn(),
  pgPoolGetItemById: vi.fn(),
  pgPoolRandom: vi.fn(),
};
vi.mock('../pool-pg.mjs', () => pgMock);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  // default env for TTL
  process.env.UC_POOL_ITEM_TTL_S = '900';
});

describe('pool.mts', () => {
  it('poolAddItem writes to PG and Redis and returns deterministic item_id', async () => {
    const { poolAddItem } = await import('../pool.mts');

    const payload = { data: { a: 1, b: 'x' }, encoding: 'json' as const, content_type: 'application/json' };
    const expectedId = createHash('sha1')
      .update(`json:${JSON.stringify(payload.data)}`)
      .digest('hex');

    const res = await poolAddItem('quotes', '/quotes', payload);

    expect(res?.item_id).toBe(expectedId);
    expect(pgMock.pgPoolAddItem).toHaveBeenCalledTimes(1);
    expect(pgMock.pgPoolAddItem.mock.calls[0][2]).toMatchObject({ item_id: expectedId });

    // sadd was called with the item id in the set
    const saddArgs = redisMock.sadd.mock.calls[0];
    expect(saddArgs?.[1]).toBe(expectedId);

    // item set with TTL
    const setArgs = redisMock.set.mock.calls[0];
    expect(setArgs?.[2]).toMatchObject({ ex: 900 });
  });

  it('poolRandom returns from Redis when available', async () => {
    // Arrange Redis to have an id and the item
    redisMock.srandmember.mockResolvedValueOnce('id1');
    redisMock.get.mockResolvedValueOnce({ data: { q: 'hi' }, encoding: 'json', content_type: 'application/json' });

    const { poolRandom } = await import('../pool.mts');
    const item = await poolRandom('quotes', '/quotes');

    expect(item).toMatchObject({ item_id: 'id1', data: { q: 'hi' }, from: 'redis' });
    expect(pgMock.pgPoolGetItemById).not.toHaveBeenCalled();
    expect(pgMock.pgPoolRandom).not.toHaveBeenCalled();
  });

  it('poolRandom falls back to PG by id and backfills Redis when Redis item missing', async () => {
    redisMock.srandmember.mockResolvedValueOnce('id2');
    // Redis get miss
    redisMock.get.mockResolvedValueOnce(null);
    // PG returns by id
    pgMock.pgPoolGetItemById.mockResolvedValueOnce({
      item_id: 'id2',
      item: { q: 'pg' },
      encoding: 'json',
      content_type: 'application/json',
      created_at: '2025-09-01T00:00:00Z',
    });

    const { poolRandom } = await import('../pool.mjs');
    const item = await poolRandom('quotes', '/quotes');

    expect(item).toMatchObject({ item_id: 'id2', data: { q: 'pg' }, from: 'pg' });
    // backfill set
    expect(redisMock.set).toHaveBeenCalled();
  });

  it('poolRandom reads random from PG when Redis set empty and backfills set+item', async () => {
    // Redis set empty
    redisMock.srandmember.mockResolvedValueOnce(null);
    // PG random returns
    pgMock.pgPoolRandom.mockResolvedValueOnce({
      item_id: 'rid',
      item: { x: 1 },
      encoding: 'json',
      content_type: 'application/json',
      created_at: '2025-09-01T00:00:00Z',
    });

    const { poolRandom } = await import('../pool.mjs');
    const item = await poolRandom('quotes', '/quotes');

    expect(item).toMatchObject({ item_id: 'rid', data: { x: 1 }, from: 'pg' });
    // sadd with new id and set backfill
    expect(redisMock.sadd).toHaveBeenCalled();
    expect(redisMock.set).toHaveBeenCalled();
  });
});
