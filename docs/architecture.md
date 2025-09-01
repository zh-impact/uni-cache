# Uni-Cache 架构设计（微服务 · Netlify Functions · Neon · Upstash）

本架构文档描述如何在 Netlify Serverless 与 Scheduled Functions 之上，采用微服务化的函数拆分，结合 Neon（PostgreSQL）与 Upstash（Redis）构建统一缓存服务（Uni-Cache）。

关联文档：
- 需求：`docs/design.md`
- 接口：`docs/api.md`

---

## 1. 目标与约束
- **遵守上游限速**：每分钟 1～5 次等；对上游调用做集中治理。
- **缓存优先**：对外高频小延迟；支持 `stale-while-revalidate` 与 `stale-if-error`。
- **服务弹性**：Serverless 自动扩缩；任务与队列解耦，避免冷启动放大（thundering herd）。
- **微服务化**：按业务能力拆分为多个 Netlify Function（HTTP）与 Scheduled Function（Cron）。
- **多存储组合**：
  - Upstash Redis：热缓存、限速计数器、任务队列。
  - Neon Postgres：源配置、任务/作业元数据、审计与可观测性数据。
- **平台约束**：部署在 Netlify；使用 `@netlify/functions`；配置通过 `netlify.toml` 与环境变量管理。

---

## 2. 高层架构
- **客户端** → （可选）Netlify Edge/Gateway → 多个 **HTTP Functions（微服务）** → Upstash（缓存与队列）/Neon（关系数据） → 上游第三方 API。
- **Scheduled Functions** 周期触发：按源策略刷新缓存、重试失败任务、生成指标快照。

组件清单：
- **Cache API 服务**：对外读（单条、批量、列表、元信息）。
- **Refresh & Prefetch 服务**：同步/异步刷新、批量预取、失效。
- **Source 管理服务（Admin）**：CRUD 源配置与策略。
- **Tasks/Jobs 服务**：任务编排、状态查询、重试。
- **Rate-Limiter 服务**：集中化对上游调用的令牌桶治理。
- **Metrics/Health 服务**：健康探针、运行指标聚合。
- **Scheduler（Cron）**：周期性批量刷新、冷键扫描、失败重试。

目录路径建议（与 Netlify Functions 对齐）：
- `netlify/functions/`：每个端点一个文件（参见 `docs/api.md`）。

---

## 3. 服务拆分与职责

### 3.1 Cache API 服务
- 端点：
  - `GET /api/v1/cache/{source_id}/{key}`
  - `POST /api/v1/cache/{source_id}/batch-get`
  - `GET /api/v1/cache/{source_id}/list`
  - `GET /api/v1/cache/{source_id}/{key}/meta`
- 读路径：
  - 命中 Upstash → 返回；
  - 未命中 → 视策略返回 202 并入队刷新，或同步向上游拉取（受限速约束）。
  - 池模式：当 `key` 对应池时，优先从池随机返回一条历史项；响应头 `X-UC-Served-From: pool-redis | pool-pg`，`ETag` 设置为池 `item_id`，支持 304。
  - 强制池模式（per‑source）：当 `source.supports_pool=true` 时，读路径仅使用池；若池为空：
    - 无 `X-UC-Cache-Only`：入队池刷新 Job 并返回 202（`X-UC-Served-From: pool-none`）
    - `X-UC-Cache-Only: true`：返回 404（`X-UC-Served-From: pool-none`）
  - 详见 `docs/api.md` 的“池模式”章节。
- ETag/If-None-Match 支持；`X-UC-Cache: HIT|MISS|STALE|BYPASS`。

### 3.2 Refresh/Prefetch/Invalidate 服务
- 端点：
  - `POST /api/v1/cache/{source_id}/{key}/refresh`
  - `POST /api/v1/cache/{source_id}/prefetch`
  - `POST /api/v1/cache/{source_id}/{key}/invalidate`
- 写路径：
  - 仅入队（Upstash 队列/Stream）；由工作者函数消费，避免冷启动风暴。
  - 支持 `Idempotency-Key` 幂等去重（Redis `SETNX` + TTL）。
  - 池作业键规范：`/pool:{key}?i=<nonce>`；`nonce` 用于绕过去重。
  - 运行器识别以 `/pool:` 开头的作业：直连上游抓取并调用池写入（不写单值缓存），用于为稳定端点累计历史项。

### 3.3 Source 管理服务（Admin）
- 端点：`/api/v1/sources*`
- Neon 持久化：源标识、Base URL、默认 header/query、限速策略、默认 TTL、键模板。
- 变更后广播配置版本号（写入 Redis），使无状态函数快速感知并缓存。

### 3.4 Task/Job 编排服务
- 端点：
  - `POST /api/v1/tasks/run`
  - `GET /api/v1/tasks/{task_id}`
- 职责：
  - 将大任务（如“刷新某源的所有热点键”）拆分为多个子 Job；
  - 写入 Neon（任务/作业元数据）；
  - 子 Job 入队到 Upstash；
  - 消费者函数拉取 Job 执行，更新状态，写回结果与指标。

### 3.5 Rate-Limiter 服务
- 端点：`GET /api/v1/rate-limit/{source_id}`（可选）
- Redis 令牌桶实现：`uc:rl:{source_id}` 保存窗口与剩余额度；
- 所有“直连上游”的函数在调用前必须先 `ACQUIRE` 配额，失败返回 429（或降级返回 STALE）。

### 3.6 Metrics/Health 服务
- 端点：
  - `GET /api/v1/healthz`
  - `GET /api/v1/info`
  - `GET /api/v1/metrics`
- 指标：命中率、MISS、STALE、任务队列深度、吞吐、错误率等。

### 3.7 Scheduler（Netlify Scheduled Functions）
- 任务：
  - 定时 `run` 各源的刷新周期（按配置窗口分配额度）；
  - 冷热点迁移扫描；
  - Job 失败重试；
  - 指标快照与清理。
- Netlify 配置：在函数导出的 `config` 中指定 `schedule`（Cron 表达式），或在 `netlify.toml` 中声明（以平台文档为准）。

---

## 4. 存储设计

### 4.1 Upstash Redis（缓存/队列/限速）
- Key 设计：
  - 缓存正文：`uc:cache:{source_id}:{key_hash}` → JSON（含 `data` 与元信息），TTL=`cache_ttl_s`；
  - 元数据：可嵌入正文或拆 `uc:meta:{...}`；
  - 令牌桶：`uc:rl:{source_id}`；
  - 幂等：`uc:idemp:{hash}` TTL 窗口；
  - 任务队列：`uc:q:{source_id}`（List/Stream）；
  - 配置版本：`uc:cfg:ver:{source_id}`。
  - 池 ID 集合：`uc:pool:ids:{source_id}:{key_hash}`（Set），成员为 `item_id`。
  - 池项：`uc:pool:item:{source_id}:{key_hash}:{item_id}` → JSON，TTL=`UC_POOL_ITEM_TTL_S`。
- 建议数据字段：`data`、`etag`、`cached_at`、`expires_at`、`stale`、`origin_status`、`ttl_s`。

### 4.2 Neon PostgreSQL（配置/审计/任务元数据）
- 表（示意）：
```sql
CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  default_headers JSONB,
  default_query JSONB,
  rate_limit JSONB NOT NULL, -- { per_minute: int, burst?: int }
  cache_ttl_s INT NOT NULL,
  key_template TEXT NOT NULL,
  supports_pool BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- run|prefetch|refresh
  state TEXT NOT NULL, -- queued|running|succeeded|failed
  progress REAL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  key TEXT,
  state TEXT NOT NULL,
  attempt INT DEFAULT 0,
  error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE TABLE pool_entries (
  source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  item_id TEXT NOT NULL, -- sha1 of normalized item string
  content_type TEXT NOT NULL,
  data_encoding TEXT NOT NULL, -- 'json' | 'text' | 'binary'
  data JSONB, -- simplified; could be BYTEA for binary
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (source_id, key_hash, item_id)
);
```

### 4.3 池模式（Stable Endpoint Cache Pool）
- 目标：为稳定端点累计多条历史项，读取时随机返回，提高可用性与多样性。
- 关键点：
  - 去重：对标准化项序列化后取 SHA1 作为 `item_id`。
  - 读：先读 Redis Set 随机成员；若缺，则从 PG 随机选取并回填 Redis。
  - 写：从上游抓取后调用池写入，Redis 热缓存 + PG 持久化。
- 强制仅池读取：由每源配置 `supports_pool` 控制；启用时读路径不回落到单值缓存。
- 键规范化与哈希：使用 `normalizeKeyString` 与 `keyHash` 计算 `key_hash`。

---

## 5. 关键流程

### 5.1 读取（命中/未命中/陈旧）
1) 计算规范化键与 `key_hash`；
2) Redis 读取：
   - 池键：若为池模式，则从池中随机返回（优先 Redis，兜底 PG），并设置 `ETag=item_id`；条件请求命中返回 304。若 `source.supports_pool=true` 且池为空：无 `X-UC-Cache-Only` → 入队池刷新并返回 202（`X-UC-Served-From: pool-none`）；`X-UC-Cache-Only: true` → 返回 404（`X-UC-Served-From: pool-none`）。
   - 命中新鲜 → 返回 200（`X-UC-Cache: HIT`）。
   - 命中陈旧 → 返回 200（`STALE`），后台入队刷新。
   - 未命中 → 入队刷新并返回 202（或在 `Bypass-Cache` 且配额充足时直连上游，成功写回后返回 200）。

### 5.2 刷新/预取
1) API 接收 keys，生成 Job 批次；
2) 写 Neon 任务记录，Job 入队 Redis；
3) 消费者函数按源速率窗口从队列取 Job，调用上游，写回 Redis 缓存；
4) 更新 Neon 任务/Job 状态与进度。

### 5.3 限速治理
- 统一门面：任一直连上游前调用 `RateLimiter.acquire(source_id)`。
- 实现：Redis 脚本/原子操作（固定窗口/滑动窗口/令牌桶均可）。

### 5.4 池刷新与定时补池
- Bypass 请求：读时命中池且请求带 `X-UC-Bypass-Cache: true`，异步入队 `/pool:{key}?i=<nonce>` 作业，当前请求不等待。
- 定时补池：`scheduled-pool-fill.mts` 每分钟执行，队列为空时批量预入队并调用 `runOnce()` 消费，受 `SCHEDULED_POOL_*` 环境变量控制。
- 失败与重试：继承通用任务/作业重试策略。

---

## 6. 配置与环境变量
- `DATABASE_URL`：Neon Postgres 连接串（建议使用官方 Serverless 驱动/连接池）。
- `UPSTASH_REDIS_URL`、`UPSTASH_REDIS_TOKEN`：Upstash Redis 凭据。
- `JWT_SECRET` 或 `API_KEY`：对外认证；管理接口单独密钥。
- `DEFAULT_CACHE_TTL`、`DEFAULT_RATE_PER_MIN`、`DEFAULT_RATE_BURST`：全局默认值。
- `LOG_LEVEL`、`ENV`（development/staging/production）。
- `UC_POOL_ITEM_TTL_S`：池项热缓存 TTL（秒，默认 86400）。
- `SCHEDULED_POOL_SOURCE_ID`、`SCHEDULED_POOL_KEY`、`SCHEDULED_POOL_PREFETCH`、`SCHEDULED_POOL_TIME_BUDGET_MS`。
- 在 Netlify 控制台为不同环境配置独立变量与密钥。

---

## 7. 安全与权限
- 认证：`Authorization: Bearer` 或 `X-API-Key`；
- 授权：读与管理端点分权；
- 秘钥管理：仅存于 Netlify 环境变量；上游 Token 不下发到客户端；
- CORS：仅允许受信来源；
- 审计：Neon 记录管理操作、关键任务事件。

---

## 8. 可观测性与运维
- 日志：Netlify 平台日志 + 结构化 JSON；
- 指标：`/api/v1/metrics` 聚合缓存命中率、队列深度、任务成功率；
- 追踪：可接入 Sentry/OTel（按需）；
- 报警：队列堆积、任务失败率、命中率显著下降。

### SLO 对齐与实现建议（对应 `docs/requirements.md` Success Metrics）
- 可用性 ≥ 99.9%
  - 策略：健康检查独立；读路径优先返回 STALE；管理面与数据面隔离。
  - 指标与 SLI：`reads_total`、`read_errors_total`，`SLI = 1 - read_errors_total/reads_total`。
  - 报警：月度滑窗 < 99.9% 告警。
- 延迟（HIT）P99 ≤ 100ms
  - 策略：命中路径仅走 Redis；避免同步直连上游；减少冷启动开销（热键预热/连接复用）。
  - 指标：直方图 `read_latency_ms{result="HIT"}`；报警：5 分钟窗 p99 > 100ms。
- MISS 应答 P99 ≤ 200ms（返回 202 或 STALE）
  - 策略：未命中默认异步刷新并快速返回；直连上游需显式 hint 且受配额约束。
  - 指标：直方图 `miss_ack_latency_ms`；报警：p99 > 200ms。
- Stale‑if‑error 覆盖率 ≥ 95%
  - 策略：上游错误且存在最后一次成功值 → 返回 STALE 并入队刷新。
  - 指标：`stale_if_error_served_total / stale_if_error_opportunities_total`；低于阈值报警。
- 热键命中率（warmed keys）≥ 80%
  - 策略：维护“预热集合”并由调度器周期预取；对相关读写加标签 `warmed="true"`。
  - 指标：`cache_hit_total{warmed="true"} / (cache_hit_total{warmed} + cache_miss_total{warmed})`；低于阈值报警。
- 失效正确性：失效后错误服务率 ≤ 0.1%
  - 策略：删除/失效双写一致（Redis+Postgres）；幂等保护与写后验证采样。
  - 指标：`post_invalidate_served_total / post_invalidate_reads_total`；超阈值报警。
- 可观测性覆盖率 100%
  - 要求：所有端点输出结构化日志与统一响应头：`X-UC-Trace-Id`、`X-UC-Served-From`、`X-UC-Origin-Status`、`X-UC-Source-Id`。

### 指标命名与标签建议
- 计数器（Counter）
  - `cache_hit_total{source_id}`、`cache_miss_total{source_id}`、`cache_stale_served_total{reason="expire|error"}`
  - `reads_total{result="HIT|MISS|STALE|BYPASS"}`、`read_errors_total{type}`
  - `upstream_requests_total{source_id,status}`、`rate_limit_acquire_total{result="ok|limited"}`
  - `post_invalidate_served_total`、`stale_if_error_served_total`、`stale_if_error_opportunities_total`
- 直方图（Histogram）
  - `read_latency_ms{result}`、`miss_ack_latency_ms`、`upstream_latency_ms{status}`
- 仪表（Gauge）
  - `jobs_queued{source_id}`、`jobs_running{source_id}`、`jobs_failed{source_id}`、`queue_lag_ms{source_id}`

### 仪表盘与报警建议
- 延迟：`read_latency_ms{result="HIT"}` p99 趋势；`miss_ack_latency_ms` p99 趋势。
- 可用性：`1 - read_errors_total/reads_total`；分源下钻。
- 覆盖率：Stale‑if‑error 覆盖与 warmed keys 命中率。
- 资源：队列深度、失败率、限速余量与 429 次数。
- 异常：`post_invalidate_served_total` 非零告警。

---

## 9. 部署与 CI/CD
- Netlify 连接仓库，按分支自动部署（Preview/Prod）；
- `netlify.toml`：声明函数目录、函数超时、内存、路由与（可选）Cron；
- 数据迁移：使用 SQL 迁移工具（如 Prisma/Migra/Flyway）管理 Neon schema；
- 环境分层：dev/staging/prod 各自使用独立 Upstash/Neon 实例与 env。

---

## 10. 本地开发
- 使用 `netlify dev` 启动本地函数模拟；
- 提供 `.env.example`；
- 以 Docker 或外部服务方式连接 Neon/Upstash（建议使用各自云服务测试实例）。

---

## 11. 风险与权衡
- 冷启动：通过队列+异步刷新降低对 P99 的影响；
- 一致性：采用 `stale-while-revalidate` 与 `stale-if-error` 的最终一致策略；
- 配额枯竭：返回 STALE 或 429，调度下个窗口再拉取；
- 热点雪崩：单键刷新去抖（幂等键 + 去重窗）；
- 成本：Redis 流量/内存与 Postgres 存储增长的成本监控与归档。

---

## 12. 与接口文档的映射
- `docs/api.md` 的端点映射为一组函数文件，位于 `netlify/functions/`，例如：
  - `cache-get.mts` → `GET /api/v1/cache/{source_id}/{key}`
  - `cache-batch-get.mts` → `POST /api/v1/cache/{source_id}/batch-get`
  - `cache-list.mts`、`cache-meta.mts`
  - `cache-refresh.mts`、`cache-prefetch.mts`、`cache-invalidate.mts`
  - `tasks-run.mts`、`tasks-status.mts`
  - `rate-limit.mts`、`metrics.mts`、`healthz.mts`、`info.mts`
- Scheduled：`scheduled-refresh.mts`、`scheduled-pool-fill.mts`，在导出的 `config` 中设置 `schedule`。

---

## 13. 未来扩展
- 多租户隔离（Tenant ID 透传到 key 与表 schema）；
- 按租户/源的差异化限速与配额；
- 支持 Webhook/Events 通知缓存变更；
- 客户端 SDK 与 OpenAPI 规范文件（`openapi.yaml`）。

---

本设计在保持函数无状态与弹性的同时，通过 Redis/队列治理上游限速与缓存一致性，Neon 负责关键配置与任务编排的持久化，适配 `docs/api.md` 所定义的契约，可在 `netlify/functions/` 按文件粒度快速落地。
