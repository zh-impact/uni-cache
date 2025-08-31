# Product Requirements: Uni-Cache, unthrottled API system

## Core Requirements

### Overview

Uni-Cache provides a stable, unthrottled facade over third‑party APIs by decoupling end‑user reads from upstream fetches via caching and background refresh. Clients read from Uni‑Cache; Uni‑Cache fetches from the upstream within each source’s rate limit and refresh policies.

### Goals

- Provide a transparent caching facade for third‑party APIs to decouple client traffic from upstream rate limits and instability.
- Deliver predictable, low‑latency responses for hot data.
- Minimize integration effort: simple and consistent HTTP API, clear semantics.
- Enable administrators to manage sources, refresh/invalidate entries, and observe system health.

### Non‑Goals

- Strong consistency across all reads (eventual consistency with bounded staleness is acceptable).
- Advanced admin UI, billing, quotas, or multi‑tenant isolation in this phase.
- Provider‑specific behavior or infrastructure details in this document.

### Personas & Use Cases

- Personas
  - Backend service developers integrating with rate‑limited or unstable third‑party APIs.
  - Platform/operations engineers who operate and monitor the service.
- Representative use cases
  1) Serve data quickly under strict upstream rate limits.
  2) Return the last known good value during an upstream outage while background refresh proceeds.
  3) Pre‑warm a batch of keys ahead of a traffic spike.
  4) Manually refresh a specific key after a known upstream change.
  5) Invalidate incorrect or outdated entries.
  6) Observe health and basic metrics.

### Functional Requirements (What)

- Source management
  - Create, update, delete, and list sources with identifiers, default request parameters, default cache policy (e.g., TTL), and rate‑limit policy.
  - Validate inputs and reject malformed or conflicting configurations.
- Cache reads
  - Retrieve a single entry by source and key; return payload and metadata indicating freshness (HIT/MISS/STALE).
  - Batch read multiple keys; list keys by prefix with pagination; fetch metadata without payload when requested.
  - Support optional client hints to read from cache only or to bypass cache; define fallback behavior when hints cannot be honored.
- Refresh & prefetch
  - On MISS or STALE, enqueue a background refresh according to source policy.
  - Manually refresh a specific key; batch prefetch a list of keys.
  - Provide an option to wait briefly for completion with a bounded timeout; otherwise acknowledge asynchronously.
  - Deduplicate concurrent refreshes and ensure idempotent invocation.
- Invalidate
  - Remove an entry by source and key; subsequent reads behave as MISS until repopulated.
- Health & metrics
  - Expose basic health and service info; provide aggregated metrics such as hit/miss rates and failures.

### Non‑Functional Requirements

- Performance: P99 ≤ 100ms for cache HIT; MISS should return promptly or serve stale within 200ms when available.
- Availability: Degrade gracefully when upstream or internal components are unavailable; return clear error responses when no data can be served.
- Scalability: Support many sources and high QPS reads; protect upstreams via rate limiting and backoff.
- Reliability: Idempotent operations; deduplicate refreshes; bounded retries; eventual consistency.
- Data retention: Honor TTL policies; long‑term persistence and GC policies are implementation‑defined.
- Security: Authenticate admin operations; avoid logging sensitive data; CORS allowlist.

### Constraints & Assumptions

- Stateless compute; background work may run asynchronously and complete later than the triggering request.
- Upstream APIs enforce rate limits and may experience intermittent failures.
- Stale reads within policy are acceptable to prioritize availability and latency.
- Single‑tenant deployment assumptions for this phase.

### Dependencies & Interfaces

- Public HTTP API.
- Requires persistent storage and caching, a background processing mechanism, and a scheduling capability.
- Auth mechanism for admin operations.

### Acceptance Criteria

- Source lifecycle: valid sources can be created, updated, listed, and deleted; invalid input yields explicit 4xx errors.
- Reads: when data is available and fresh, responses meet the performance SLO; on MISS, a refresh is queued; if a stale value exists, it can be returned according to policy.
- Refresh & prefetch: on‑demand refresh and batch prefetch requests are accepted once per key (idempotent); optional short wait completes within a bounded timeout.
- Invalidate: after invalidation, the next read behaves as MISS until data is repopulated.
- Health & metrics: health reports service readiness; basic metrics expose hits, misses, stale serves, and failures.

### Out of Scope (for this phase)

- Multi‑tenant RBAC, per‑user quotas, or billing.
- Streaming responses and websockets.
- Advanced UI/UX beyond the minimal admin endpoints.
- Provider‑specific technologies, environment variables, and deployment details.

### Glossary

- Source: A named upstream API configuration with default request parameters, cache policy (e.g., TTL), and rate‑limit policy.
- Key: Deterministic identifier for a cached item within a Source; derived from request semantics (path + parameters) and unique per item.
- Cache Entry: A value and its metadata stored for a given Source and Key; metadata includes freshness indicators and timestamps.
- Fresh/HIT: Entry served within its freshness window. MISS: Entry not present. STALE: Entry expired but still eligible to be served under policy.
- Refresh: Fetching from the upstream to populate or update a cache entry; may be triggered by MISS/STALE/manual/schedule.
- Prefetch: Proactively refreshing a set of keys before anticipated demand.
- Invalidate: Removing an entry so the next read behaves as MISS until repopulated.
- TTL (Time‑to‑Live): Duration after which an entry is considered expired.
- SLO: Target objectives for performance and availability defined by this document.
- Admin Operation: Privileged actions such as managing sources or cache control operations (refresh/prefetch/invalidate).
- Client Hints: Optional request signals that influence behavior (e.g., cache‑only, bypass cache, short wait), subject to policy.

### Success Metrics

- Availability (reads): ≥ 99.9% monthly success rate for read operations (excludes admin endpoints).
- Latency (HIT): P99 ≤ 100 ms for successful cache HIT responses.
- MISS time‑to‑ack: P99 ≤ 200 ms to return either an acceptance (asynchronous) or a stale response when a stale value exists.
- Stale‑if‑error coverage: During upstream outage windows, ≥ 95% of reads to keys with a last known good value return STALE instead of hard errors.
- Hit ratio (warmed keys): ≥ 80% HIT ratio across defined warmed key sets over a rolling 24‑hour window.
- Invalidation correctness: After invalidation, probability of serving the invalidated value ≤ 0.1% across subsequent reads.
- Observability coverage: 100% of endpoints emit structured logs and basic metrics for requests and outcomes.

### Risks & Mitigations

- Upstream rate limits exhausted
  - Mitigation: Enforce bounded refresh concurrency and rate‑limit policies; degrade to STALE or defer until next window.
- Thundering herd on hot‑key MISS
  - Mitigation: Coalesce duplicate refreshes, ensure idempotency, and single‑flight semantics for the same key.
- Data staleness drift
  - Mitigation: Clear TTL policies, prefetch for hot sets, manual refresh controls, and visibility via metrics.
- Partial service outages (e.g., background processing unavailable)
  - Mitigation: Degrade reads to STALE when possible, apply backpressure, and surface clear error responses when no data is available.
- Incorrect key canonicalization causing duplicates or misses
  - Mitigation: Strict key templates, input validation, and test coverage for key construction.
- Security exposure through misuse of control operations
  - Mitigation: Authenticate/authorize admin operations, principle of least privilege, and auditability of changes.
- Bypass/force‑refresh abuse increasing upstream pressure
  - Mitigation: Guardrails and quotas for optional client hints; restrict sensitive operations to admins.
- Cost growth due to unbounded retention or prefetch
  - Mitigation: Tune TTLs, define GC/archival policies, and limit prefetch scope based on measured value.
- Multi‑tenant isolation requirements (future)
  - Mitigation: Out of scope for this phase; plan for tenant‑aware keys/policies in a future iteration.

### Appendix: Resource Types

- Stable resource, dynamic representation
  - Definition: Stable URI; data changes frequently.
  - Example: Weather API, e.g., `/weather/Shanghai`.

- Stable resource, static representation
  - Definition: Stable URI; data is static.
  - Example: Configuration API, e.g., `/config`.

- Query/computed resource
  - Definition: Parameterized or computed endpoint; data changes with inputs and time.
  - Example: Search API, e.g., `/search?q=Shanghai`.
