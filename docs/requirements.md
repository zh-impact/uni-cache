# A Unified Cache System, but more prefer call it a Unthrottled API System

## Core Requirements

### Overview

Uni-Cache provides a stable, unthrottled facade over third‑party APIs by decoupling end‑user reads from upstream fetches via caching and background refresh. Clients read from Uni‑Cache; Uni‑Cache fetches from the upstream within each source’s rate limit and refresh policies.

Reference API contract: see `docs/api.md` (v1 endpoints under `/api/v1`).

### Functional Requirements

1) Source management
- CRUD for Source objects: `id`, `name`, `base_url`, `default_headers` (object), `default_query` (object), `rate_limit` ({ per_minute, burst? }), `cache_ttl_s` (default TTL), `key_template`.
- Validation: `id` is required and unique; numeric fields are finite; objects must be JSON.
- Idempotency for create/update via `Idempotency-Key` (recommendation); errors: 400/409/401/403 as appropriate.
- HTTP endpoints: `/api/v1/sources` and `/api/v1/sources/:source_id`.

2) Cache read paths
- Single read: `GET /api/v1/cache/{source_id}/{key}` returns `{data, meta}` on HIT; supports `If-None-Match` → 304.
- Batch read: `POST /api/v1/cache/{source_id}/batch-get` with `keys: string[]`.
- List keys by prefix: `GET /api/v1/cache/{source_id}/list?prefix&cursor&limit`.
- Metadata only: `GET /api/v1/cache/{source_id}/{key}/meta`.
- Response headers: `X-UC-Cache (HIT|MISS|STALE|BYPASS)`, `X-UC-Age`, `ETag`, `Cache-Control`.

3) Refresh/Prefetch/Invalidate triggers
- Read MISS/STALE queues a refresh (respect per‑source rate limits).
- Manual refresh: `POST /api/v1/cache/{source_id}/{key}/refresh` → 200 (sync) or 202 (queued) with `task_id`.
- Batch prefetch: `POST /api/v1/cache/{source_id}/prefetch` with `keys` → 202; deduplicate by key + source.
- Invalidate: `POST /api/v1/cache/{source_id}/{key}/invalidate` → 204.
- Request headers:
  - `X-UC-Bypass-Cache: true` → try direct upstream (within limits) and update cache; fallback to cache if cannot.
  - `X-UC-Cache-Only: true` → serve from cache only, never touch upstream.
  - `X-UC-Wait: 1` → best‑effort synchronous wait for the triggered refresh with timeout; else 202.
  - `Idempotency-Key` for write‑like operations (refresh/prefetch/invalidate).

4) Storage model and semantics
- Primary cache: Upstash Redis. Keys are normalized; value is a `CacheEntry` with `meta`.
- Persistence: Neon Postgres stores long‑term `cache_entries` (write‑through by default, configurable per write).
- Read‑through: on Redis miss, read from Postgres; if found, backfill Redis with the remaining TTL derived from `expires_at` (if expired, backfill with short TTL, e.g., 60s) per `netlify/lib/cache.mts`.
- Delete removes from both Redis and Postgres.
- Metadata fields include: `etag`, `last_modified`, `origin_status`, `content_type`, `data_encoding` (default `json`), `cached_at`, `expires_at`, `ttl_s`, `stale`.

5) Rate limiting, queuing, and task runner
- Per‑source queues with deduplication and idempotency.
- Execution respects each source’s `rate_limit.per_minute` and optional `burst`.
- A shared runner `runOnce(opts)` consumes per‑source queues with retries/backoff and updates cache.
- On‑demand run: `POST /api/v1/tasks/run` with optional `source_id`, `max_per_source`, `time_budget_ms`, and optional `keys` (when queue empty, enqueue then immediately consume).
- Scheduled run: Netlify Scheduled Functions invoke the runner periodically (default cron `*/5 * * * *`), overridable by env.

6) Consistency & freshness
- `stale-while-revalidate`: serve stale briefly while refreshing in background.
- `stale-if-error`: on upstream failure, serve last good value within an acceptable window.
- ETag/If-None-Match support to minimize upstream cost.

7) Observability and metrics
- `GET /api/v1/metrics` provides basic runtime metrics (uptime, cache hits/misses, queue sizes, failures).
- Expose per‑request headers (`X-UC-*`) and structured logs for queue consumption and refresh results.
- Optional `GET /api/v1/tasks/status/{task_id}` to track queued/running/succeeded/failed.

8) Security & administration
- Authentication: `Authorization: Bearer <token>` or `X-API-Key: <token>`.
- Source and task management endpoints restricted to admins.
- Secrets (upstream tokens) stored server‑side; not exposed to clients. CORS allowlist configurable per deployment.

9) Management UI (Phase 2)
- View/create/update/delete Sources.
- Browse CacheEntries (list/filter by prefix, view meta/data), invalidate, trigger refresh/prefetch.

### Non‑Functional Requirements

- Performance: P99 ≤ 100ms for cache HIT responses; MISS should return promptly with 202 or serve stale within 200ms when available.
- Availability: Degrade gracefully if Redis is unavailable by falling back to Postgres (read‑through); if both fail, return 5xx with clear error model.
- Scalability: Support many sources and high QPS reads; queue and runner must protect upstreams via rate limits and backoff.
- Reliability: Idempotent queueing; deduplicate same key refreshes; retry with bounded backoff; at‑least‑once refresh semantics.
- Data retention: Redis TTL enforced by `ttl_s`; Postgres keeps historical entries as the source of truth; GC policies can be added later.
- Security: Do not log sensitive headers; enforce admin auth on management endpoints.

### Configuration & Environment

- Platform: Netlify Functions + Netlify Scheduled Functions.
- Runtime: Node 18+, TypeScript.
- Environment variables:
  - Upstash Redis: `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`.
  - Postgres (Neon): `DATABASE_URL`.
  - Scheduled runner overrides: `SCHEDULED_REFRESH_SOURCE_ID`, `SCHEDULED_REFRESH_MAX_PER_SOURCE`, `SCHEDULED_REFRESH_TIME_BUDGET_MS`.

### Acceptance Criteria

- After creating a Source, `GET /api/v1/cache/{source_id}/{key}` returns HIT when populated, MISS otherwise with refresh queued; `X-UC-Cache` reflects state.
- On Redis miss with existing Postgres entry, service returns the entry and backfills Redis with remaining TTL.
- `POST /api/v1/cache/{source_id}/{key}/refresh` returns 200 when completed synchronously, or 202 with `task_id` when queued.
- `POST /api/v1/cache/{source_id}/prefetch` enqueues unique keys and returns 202.
- `POST /api/v1/tasks/run` consumes queues honoring `max_per_source` and `time_budget_ms` and returns a summary as in `docs/api.md`.
- `GET /api/v1/metrics` exposes basic counters; error responses follow the error model in `docs/api.md`.

### Out of Scope (for this phase)

- Multi‑tenant RBAC, per‑user quotas, or billing.
- Streaming responses and websockets.
- Advanced UI/UX beyond the minimal admin endpoints.

### Stable resource, dynamic representation

Weather API, e.g., `/weather/Shanghai`: stable URL, frequently changing data.

### Stable resource, static representation

Configuration API, e.g., `/config`: stable URL, static data.

### Query/computed resource

Search API, e.g., `/search?q=Shanghai`: varying URL (parameterized), changing data.
