# Uni-Cache API 设计

面向第三方 API 的限速抓取与本地缓存层，对外提供稳定的高频访问接口。

本接口文档基于 `docs/design.md` 的核心需求：
- 遵守源 API 限速（每分钟 1～5 次等），定时抓取；
- 将响应结果存入本地数据库；
- 对外优先返回缓存，避免外部直接命中第三方 API。

## 基础信息
- 版本：v1
- 建议基础路径：`/api/v1`（在 Netlify Functions 中可通过 `config.path` 绑定到此路径）
- 返回格式：`application/json; charset=utf-8`
- 字段命名：`snake_case`

## 认证与授权
- 建议使用以下任一方式：
  - Header: `Authorization: Bearer <token>`
  - 或 Header: `X-API-Key: <token>`
- 管理类接口（源配置、任务控制）建议仅限内部或管理员使用。

## 通用请求头（可选）
- `X-UC-Bypass-Cache: true`：当缓存存在但需要强制从源拉取（受限速与后台队列约束），若无法立即拉取则返回缓存并在后台刷新。
- `X-UC-Cache-Only: true`：仅使用缓存，不触发任何上游请求。
- `X-UC-Wait: 1`：对触发的刷新操作尽量同步等待（设置超时，超时则返回 202）。
- `Idempotency-Key: <uuid>`：对刷新/预取/失效等“写”操作进行幂等保护。

## 通用响应头
- `X-UC-Cache: HIT | MISS | STALE | BYPASS`
- `X-UC-Age: <seconds>`：缓存龄期。
- `ETag: <etag>`：缓存内容标签，配合 `If-None-Match` 支持 304。
- `Cache-Control`：对下游客户端的建议缓存策略（不替代服务端缓存）。
- 限速头（针对本服务对上游的配额，而非下游客户端）：`X-RateLimit-Limit`、`X-RateLimit-Remaining`、`X-RateLimit-Reset`。

## 数据模型（抽象）
- Source（数据源）：
  - `id`（string）：唯一标识。
  - `name`（string）
  - `base_url`（string）
  - `default_headers`（object，可选）
  - `default_query`（object，可选）
  - `rate_limit`（object）：`{"per_minute": number, "burst"?: number}`
  - `cache_ttl_s`（number）：默认缓存 TTL。
  - `key_template`（string）：键生成规则，例如：`/users/{{user_id}}/profile`。
- CacheEntry（缓存条目）：
  - `source_id`、`key`、`params`（object）
  - `data`（任意 JSON）
  - `etag`、`cached_at`、`expires_at`、`last_fetch_at`、`origin_status`
  - `stale`（bool）、`ttl_s`、`refresh_state`（`idle|queued|running|failed|ok`）

> 实现可使用 Redis / SQLite / PostgreSQL / MongoDB 等，本文档与存储无关。

---

# 接口列表

## 1. 健康与信息

### GET /api/v1/healthz
- 描述：健康检查。
- 响应 200：`{"status":"ok"}`

### GET /api/v1/info
- 描述：服务信息、配置摘要。
- 响应 200：
```json
{
  "name": "uni-cache",
  "version": "1.0.0",
  "time": "2025-08-30T00:00:00Z"
}
```

## 2. Source 管理（Admin）

### POST /api/v1/sources
- 描述：创建源配置。
- 请求体：
```json
{
  "id": "weather",
  "name": "Weather API",
  "base_url": "https://api.example.com",
  "default_headers": {"Authorization": "Bearer <upstream-token>"},
  "rate_limit": {"per_minute": 5, "burst": 2},
  "cache_ttl_s": 600,
  "key_template": "/weather/{{city}}"
}
```
- 响应 201：返回完整 Source。
- 错误：400/409/401/403

### GET /api/v1/sources
- 描述：源列表。
- 响应 200：`[{...}]`

### GET /api/v1/sources/{source_id}
- 描述：源详情。
- 响应 200：`{...}`；404：不存在。

### PATCH /api/v1/sources/{source_id}
- 描述：部分更新（如限速、TTL、头部）。
- 请求体：允许任意可更新字段。
- 响应 200：更新后的 Source。

### DELETE /api/v1/sources/{source_id}
- 描述：删除源及其缓存（可选提供 `?keep_cache=1` 保留缓存）。
- 响应 204。

## 3. 缓存读取（对外高频）

> 优先命中缓存；若 `X-UC-Bypass-Cache: true` 则在限速内尝试直连源，并更新缓存。

### GET /api/v1/cache/{source_id}/{key}
- 描述：读取单条缓存（`key` 为根据 `key_template` 生成的规范化键）。
- 可选：支持 `If-None-Match`，命中则 304。
- 响应 200：
```json
{
  "data": {"temp": 29.3, "unit": "C"},
  "meta": {
    "source_id": "weather",
    "key": "/weather/Shanghai",
    "cached_at": "2025-08-29T16:00:00Z",
    "expires_at": "2025-08-29T16:10:00Z",
    "stale": false,
    "etag": "W/\"1a2b3c\"",
    "origin_status": 200
  }
}
```

### POST /api/v1/cache/{source_id}/batch-get
- 描述：批量读取缓存。
- 请求体：
```json
{
  "keys": ["/weather/Shanghai", "/weather/Beijing"]
}
```
- 响应 200：
```json
{
  "items": [
    {"key": "/weather/Shanghai", "hit": true,  "data": {...}, "meta": {...}},
    {"key": "/weather/Beijing",  "hit": false, "data": null, "meta": {"stale": null}}
  ]
}
```

### GET /api/v1/cache/{source_id}/list
- 描述：按前缀罗列缓存键。
- 查询：`prefix`、`cursor`、`limit`（默认 50，最大 1000）。
- 响应 200：
```json
{
  "items": [{"key": "/weather/Shanghai"}, {"key": "/weather/Beijing"}],
  "next_cursor": "abc123"
}
```

### GET /api/v1/cache/{source_id}/{key}/meta
- 描述：仅返回元数据，不含正文。
- 响应 200：`{"key":"...","cached_at":"...","stale":false,...}`

## 4. 刷新 / 预取 / 失效

### POST /api/v1/cache/{source_id}/{key}/refresh
- 描述：触发单个键刷新。可能为异步执行。
- 头：可用 `Idempotency-Key` 去重。
- 响应：
  - 200：同步完成，返回新内容
  - 202：已入队，`{"task_id": "t_123"}`
  - 409：同键刷新任务已存在

### POST /api/v1/cache/{source_id}/prefetch
- 描述：批量预取（常用于“热数据”）
- 请求体：
```json
{
  "keys": ["/weather/Shanghai", "/weather/Beijing"],
  "priority": "normal"  
}
```
- 响应 202：`{"task_ids": ["t_1","t_2"]}`

### POST /api/v1/cache/{source_id}/{key}/invalidate
- 描述：使缓存失效（删除或标记过期）。
- 响应 204。

## 5. 任务与限速

### POST /api/v1/tasks/run
- 描述：手动触发一个后台采集周期（遵守每源限速）。
- 查询/请求体参数（均为可选）：
  - `source_id`（string）：限定只运行某一源；不传则对所有源各执行一轮。
  - `max_per_source`（number）：单次每源最多消费的队列作业数，默认 20。
  - `time_budget_ms`（number）：本次运行的时间预算（毫秒），默认 5000。
- 请求体（可选）：
```json
{
  "source_id": "weather",
  "keys": ["/weather/Shanghai", "/weather/Beijing"],
  "max_per_source": 20,
  "time_budget_ms": 5000
}
```
  - 当同时提供 `source_id` 与 `keys` 且该源队列当前为空时，将先把这些 `keys` 入队，再立刻调用共享运行器消费（保持与预取一致的队列语义）。
  - 若队列不为空，则跳过入队，直接运行消费。
- 响应 200（示例）：
```json
{
  "ok": true,
  "processed_sources": 1,
  "per_source": {
    "weather": { "dequeued": 2, "updated": 1, "not_modified": 1, "errors": 0 }
  },
  "duration_ms": 1234,
  "endpoint": "tasks-run",
  "source_id": "weather",
  "prefetch": { "enqueued": 2, "duplicates": 0, "idempotent_rejects": 0, "task_ids": ["t_1", "t_2"] },
  "debug": {
    "queue_len_before": 0,
    "queue_len_after_enqueue": 2,
    "queue_len_after_run": 0,
    "run_opts": { "source_id": "weather", "maxPerSource": 20, "timeBudgetMs": 5000 }
  }
}
```
  - 说明：`prefetch` 仅在符合“队列为空且提供 keys”时返回；`debug.run_opts` 字段名与实现一致（驼峰命名）。

### GET /api/v1/tasks/status/{task_id}
- 描述：查询任务状态。
- 响应 200：
```json
{"task_id":"t_1","state":"queued|running|succeeded|failed","progress":0.42}
```

### GET /api/v1/rate-limit/{source_id}
- 描述：查看某源的当前配额窗口与剩余额度。
- 响应 200：`{"per_minute":5,"remaining":2,"reset_at":"..."}`

## 6. 观测与指标

### GET /api/v1/metrics
- 描述：简要运行指标（JSON）。
- 响应 200：
```json
{
  "uptime_s": 36000,
  "cache": {"hit": 120394, "miss": 2301, "stale_served": 83},
  "jobs": {"queued": 3, "running": 1, "failed": 0},
  "sources": {"count": 2}
}
```

---

## 错误码
- 400：请求参数错误
- 401/403：未认证/无权限
- 404：资源不存在
- 409：资源冲突（如刷新任务重复）
- 422：语义或校验失败
- 429：达到服务侧限速（对上游配额保护）
- 502：上游错误
- 504：上游超时
- 5xx：服务内部错误

## 典型调用流程
1) 客户端读取：`GET /api/v1/cache/weather/\u002Fweather\u002FShanghai`
- 命中缓存返回 200，`X-UC-Cache: HIT`。
- 若 MISS，服务尝试后台抓取并返回 202（或先返回空/占位并在后台填充）。

2) 热数据预热：`POST /api/v1/cache/weather/prefetch` 携带 keys。

3) 定时作业：平台级定时器（如 Netlify Scheduled Functions）周期触发 `/api/v1/tasks/run`，逐键/按策略刷新，遵守 `rate_limit`。

4) 观测与报警：客户端轮询 `/metrics`、`/tasks/{id}`，或将失败任务写入告警。

## 键生成与参数化（建议）
- 使用 `key_template` 保证键规范与可推导：
  - 模板：`/weather/{{city}}`
  - 输入：`{"city":"Shanghai"}` → 键：`/weather/Shanghai`
- 服务端需统一转义与大小写规范，避免重复键。

## 缓存一致性策略（建议）
- `stale-while-revalidate`：过期后可短期返回 STALE，同时后台刷新。
- `stale-if-error`：上游错误时在可接受窗口内继续返回旧值。
- 支持 ETag/If-None-Match 与 304 以降低上游成本。

## 安全（建议）
- 管理接口需管理员 Token；
- 关键配置（上游密钥）仅在服务端保存，避免下发给客户端；
- 视需要开启 CORS 白名单与 IP 允许列表。

---

以上为实现无关的接口契约，适配任意存储（Redis/SQLite/Postgres/Mongo）与任意部署环境（含 Netlify Functions）。实现时可按本仓库函数风格在 `netlify/functions/` 下为各端点分别创建入口，并通过 `config.path` 绑定到本文路径。
