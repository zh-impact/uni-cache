# A Unified Cache System, but more prefer call it a Unthrottled API System

## Core Requirements

- 当调用有速率限制的第三方 API 时，该系统会将你的调用转变为不受速率限制的 API 调用。
- 当调用不够稳定的第三方 API 时，该系统将会保障你的 API 调用的稳定性。
- 你调用任意 API 时，都可以将该系统当作透明中间层，通过该系统进行第三方 API 调用。

## Split Tasks

### 1. Define Source

Source 代表一个第三方 API 源。

- 第三方 API Source 的定义，包括源 ID、源名称、源 URL、源头部、源策略等。
- 第三方 API Source 的的管理，包括创建、更新、删除、查询等操作。
- 第三方 API Source 的策略配置，包括限速、TTL、刷新、预取等策略。

### 2. Support multiple ways to trigger Source Item to Cache Entry Refresh

- 读 MISS/STALE 回源：GET /api/v1/cache/{source_id}/{key} 命中失败时入队刷新（或 X-UC-Bypass-Cache: true 直连上游）
- 手动刷新：POST /api/v1/cache/{source_id}/{key}/refresh。
- 批量预热：POST /api/v1/cache/{source_id}/prefetch。
- 定时任务：周期性按源策略批量刷新。

### 3. 多重存储

Redis + PostgreSQL

### 4. 管理界面

- 提供一个管理界面，用于查看及管理 sources.
- 提供一个管理界面，用于查看及管理 entries.

## Source Type

### Stable resource, dynamic representation

天气 API，如：`/weather/Shanghai`，请求地址是固定的，但数据是变化的。

### Stable resource, static representation

配置 API，如：`/config`，请求地址是固定的，但数据是固定的。

### Query/computed resource

搜索 API，如：`/search?q=Shanghai`，请求地址是变动的，但数据是变化的。
