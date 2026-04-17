## Context

本项目零历史代码, 完全新建.  架构决策以 `discuss/design-agent-teams-mcp-20260414.md` (Status: APPROVED, Mode: Builder) 为权威来源, 该文档列出 Approach A (MVP 基础设施: agent + mailbox + tasks) → Approach B (contracts 层) 两期策略, 及 16 条 Reviewer Concerns + Failure-mode 清单.

技术基线:
- TypeScript + `@modelcontextprotocol/sdk` + `fastify` + `better-sqlite3` + `zod`
- npm 单包, `npx ts-agent-teams daemon` 启动
- 所有 agent 走同一 HTTP MCP daemon; stdio 不支持 (1:1 session 无法多路共享)
- 本机信任模型: daemon 仅监听 `127.0.0.1`, 默认无 auth; 可选 `--token` 开启 bearer 鉴权

上游文档约束:
- 统一 `events` outbox (所有 audit + fan-out 都走这一张), JSONL 已废弃
- `agent_id` = MCP session UUID, 人不指定; 碰撞即 bug → 409
- `team` 字段 MVP 就支持, 所有查询 WHERE team 过滤
- Phase 0 三家 agent 连通性 e2e 是硬前置, 失败走 stdio-proxy Plan B

## Goals / Non-Goals

**Goals:**
- 三家 code agent (opencode + Claude Code + Codex CLI) 通过同一 HTTP MCP daemon 注册 / 发消息 / 领任务 / 查契约 (Phase 0~3 全量)
- 所有跨 agent 消息与契约变更最终持久化到同一 `events` outbox 表, client 用 `event_id` cursor 去重, daemon 重启不丢事件
- `register_contract` 并发安全 — 事务串行化保证 version 顺序递增, diff 基于前一 version 自动计算
- 合理错误分类: `unknown_recipient` / `already_claimed` (带 owner) / `not_owner` / `storage_unavailable` / `invalid_token` / 409 (session 碰撞) / 403 (身份不符)
- 可观测的清理: `events` 表 7-day cleanup, 但边界安全 — 不清理任何一个在线 agent 的 `last_processed_event_id` 之后的范围

**Non-Goals:**
- 远程 / 跨机 agent 协作 (daemon 锁死 127.0.0.1)
- 多用户 / 多租户 / OAuth (本机信任)
- OpenAPI / proto 等非 JSONSchema 契约格式 (Phase 3 之后)
- Contract 的语义化 / 业务级 diff (只做结构化深度 diff)
- 消息加密 / 审计签名 (本机信任)
- CI/CD 自动发版 (稳定后手动 `npm publish`)
- Contract 历史 UI 展示 (用户自己写辅助工具查 SQL)
- 在 daemon 内处理 agent 之间的权限 / 沙箱 (信任所有本机 agent)

## Decisions

### D1: 传输层锁死 MCP Streamable HTTP, stdio 仅作 Plan B 回落

**选项对比:**
- stdio: 1:1 client-server, 多 agent 无法共享一个 daemon 实例 — 直接排除
- SSE (deprecated old MCP spec): 单向 server→client, 不满足 request/response — 排除
- **Streamable HTTP (2025 官方 spec)**: 支持 request/response + server→client SSE push, 官方标准, 三家 agent 均声明支持 — 选它

**Plan B:** 若 Phase 0 e2e 发现某 agent 不支持 Streamable HTTP, 写 ~100 行的 stdio MCP proxy 子包, 把 stdio tool call 透传到 HTTP daemon.  对 agent 接口层面透明.

### D2: 持久化层 = better-sqlite3 + 单一 `events` outbox

- **`better-sqlite3` (同步 API)**: Electron / local-first 事实标准, 单进程单用户场景延迟 <1ms; 批量 / diff 计算才用 `node:worker_threads` 避免阻塞事件循环
- **PRAGMA**: `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`
- **Outbox pattern**: `events(event_id INTEGER PRIMARY KEY AUTOINCREMENT, team, event_type, actor_agent_id, payload JSON, created_at)`.  所有对外发布的事件都写这张表, 然后 fan-out (SSE push + polling 都从这读).  messages / tasks state changes / contracts changes 全部走同一条 append 路径.
- **索引**: `idx_events_team_eventid (team, event_id)` 保证 `WHERE team=? AND event_id>? ORDER BY event_id` 是 O(log n)

### D3: `agent_id` = MCP session UUID, human-readable metadata 走 `role` / `display_name`

- MCP SDK 为每次 HTTP MCP session 分配 UUID, daemon 直接采用
- `register_agent` 入参: `{ model, role, display_name?, team? }`, 返回 `{ agent_id (server-assigned), team }`
- 同 session 重复调 = upsert metadata, **不**视为冲突
- 不同 TCP session 但 agent_id 碰撞 = daemon bug, 返回 409 并记日志
- 寻址支持 `to_agent_id` (临时精确) + `to_role` (稳定模糊, 多个 agent 时广播到 role 下所有在线 agent)

### D4: `task_claim` 用单语句 CAS 避免并发抢占

```sql
UPDATE tasks
SET status='in_progress', claimed_by=?, claimed_at=?
WHERE id=?
  AND status='pending'
  AND NOT EXISTS (
    SELECT 1 FROM tasks d
    WHERE d.id IN (SELECT value FROM json_each(tasks.depends_on))
      AND d.status != 'completed'
  )
```
- `changes()` == 1 → 成功, 返回 `{ ok: true }`
- `changes()` == 0 → 读 owner, 返回 `{ error: 'already_claimed', owner: claimed_by }` 或 `{ error: 'dependencies_pending' }`

### D5: `register_contract` 串行化 version 递增

`BEGIN IMMEDIATE` 事务 + `SELECT MAX(version) FROM contracts WHERE team=? AND name=?` → `INSERT ... version=max+1` → COMMIT.  SQLite `BEGIN IMMEDIATE` 获取写锁, 与 `busy_timeout=5000` 协作保证并发 `register_contract` 串行化, 不会出现两个 writer 拿到同一 `max` 导致 version 冲突.

### D6: `events` 表 7-day cleanup + 未确认消费范围保护

每 1h `setInterval` 触发 cleanup.  安全边界:
1. 读所有 `online` agent 的 `last_processed_event_id` (agents 表新增列, polling / SSE 确认时更新)
2. 计算 `floor = min(last_processed_event_id over online agents)`
3. DELETE WHERE `created_at < now()-7d AND event_id < floor`

若无在线 agent, 回退到纯时间条件 (7 天足以覆盖正常离线, 超过 7 天的 agent 被视为已弃用).  `contracts` / `tasks` / `agents` 三张当前态表不清理.

### D7: Breaking 判定规则 (最保守集)

`breaking = true` 当且仅当以下之一:
- `removed_fields` 非空
- 任一 `changed_fields` 中 `from.required=false` 且 `to.required=true`
- 任一 `changed_fields` 中 `from.type` 与 `to.type` 字符串不等 (e.g. `"string"` → `"number"`, `"object"` → `"array"` 等)

其他变更 (新增可选字段, enum 扩展, description 改) = `breaking: false`.  后续迭代放宽.

### D8: JSON Pointer 嵌套路径格式

深度 diff 用 JSON Pointer 指示 schema 内节点, 严格遵守 RFC 6901 格式: 嵌套属性写 `/properties/user/properties/id` **不是** `/properties/user/id`.  复用社区库 `json-schema-diff-validator` 或 `json-diff-kit` 抽底层, 不自造轮子.

### D9: SSE fanout 与 cursor 去重

- daemon 维护 `session_id -> { agent_id, team }` 内存映射; 每个 active HTTP MCP session 暴露一条 SSE 流
- `register_contract` / `send_message` / `task_*` 成功写 events 表后, 同步 fan-out 到该 team 内所有在线 session 的 SSE 流
- 离线 agent 不 block 写入, 上线后调 `pending_contract_events({since_event_id})` / `get_inbox({since_event_id})` 补齐
- client 侧只信 `last_processed_event_id` 作为去重依据, 服务端不维护 per-subscriber cursor

### D10: 文件组织

| 目录 | 内容 |
|---|---|
| `src/daemon/` | Fastify app, pid 文件管理, 端口选择, 优雅停止, SSE fanout |
| `src/mcp/` | 每个 MCP tool 一个文件: `register_agent.ts`, `send_message.ts`, ... |
| `src/storage/` | `db.ts` (SQLite bootstrap + PRAGMA), `events-outbox.ts`, `agents-repo.ts`, `messages-repo.ts`, `tasks-repo.ts`, `contracts-repo.ts` |
| `src/schemas/` | zod schemas per tool |
| `src/lib/` | JSONSchema diff 封装, JSON Pointer 格式化 |
| `tests/` | 每个 tool / repo 一个独立测试文件, 命名 `*.test.ts` |
| `docs/configs/` | opencode / Claude Code / Codex CLI 连接 JSON 片段 |

## Risks / Trade-offs

- **三家 agent 的 Streamable HTTP 实现差异** → Phase 0 e2e 硬前置, 失败走 stdio-proxy Plan B (D1)
- **`better-sqlite3` 同步 API 阻塞 Fastify 事件循环** → 单条 query <1ms 接受直接同步; 批量或 diff 计算迁到 `node:worker_threads`; 阶段 1 压测后定阈值
- **`events` 表无限增长** → 7-day cleanup + 未消费范围保护 (D6); 未来需要更长保留期则走 archive 策略, 不在本 change 内
- **并发 `register_contract` 同 name** → `BEGIN IMMEDIATE` 事务串行化 (D5); 最差两个 writer 各自 wait busy_timeout 后仍成功, 不丢数据不乱序
- **SQLite 磁盘满 / WAL 锁死 静默 500** → 全局 `try/catch` 包 DB 操作, 异常一律映射到 `{ error: 'storage_unavailable' }` 透出给 MCP client
- **events 表清理误删未消费事件** → cleanup 函数取 online agent 最小 cursor 作为下界, 无在线 agent 时回退到 7-day 边界
- **token 鉴权误用** → header 缺失 / 不匹配 → 401 `{ error: 'invalid_token' }`; agent_id 与 session UUID 不符 → 403 (防止 agent 伪装他人身份)

## Runtime Assumptions

### A1: MCP Streamable HTTP transport 在三家 agent 上的行为一致

**Assumption**: opencode / Claude Code / Codex CLI 三家 agent 均实现 MCP Streamable HTTP spec (2025 官方), 能建立 HTTP MCP session 并与 daemon 完成 tool call round-trip.

**Rationale**: 设计决策 D1 依赖此前提; Reviewer Concerns#16 将其列为"Phase 0 连通性硬前置".  若任一 agent 不支持, 必须回落 stdio-proxy Plan B.

**Verification**: Task 4.2 `tests/e2e-connectivity.test.ts` — 三个 agent 各自通过 HTTP MCP 连 daemon 调 `echo`, 返回符合预期即通过; 任一失败走 Plan B (stdio-proxy 子包, 延后至本 change 之外或 concerns#11).

### A2: `better-sqlite3` 同步 API 在 Fastify 上无明显事件循环阻塞

**Assumption**: 单条 `prepare().get()/run()` 延迟 <1ms, 直接同步不触发 Fastify 连接超时.

**Rationale**: `better-sqlite3` 在 Electron / local-first 应用中是事实标准, 社区基准显示单查询亚毫秒.

**Verification**: Task 2.1 bootstrap 后 Task 9.4 (100 并发 register_contract) 隐含实测延迟; 若超 10ms 则迁到 `worker_threads` (Concerns#12).

### A3: SQLite `BEGIN IMMEDIATE` + `busy_timeout=5000` 能串行化 `register_contract` 并发写

**Assumption**: `BEGIN IMMEDIATE` 获取 RESERVED 锁, 其他 writer 在 busy_timeout 内会自然排队, 不会出现 `SELECT MAX(version)` 读到同一值后两个 INSERT 冲突.

**Rationale**: SQLite 文档明确规定 RESERVED 锁语义; WAL 模式下 reader 不阻塞 writer 但 writer 之间仍串行.

**Verification**: Task 9.4 `tests/register-contract-concurrent.test.ts` — 100 次并发 `register_contract` 同 name, 断言 version 是 1..100 的完整序列且无重复.

### A4: `node:setInterval` 在 daemon 进程生命周期内可靠触发 cleanup

**Assumption**: daemon 长驻进程内 `setInterval(fn, 3_600_000)` 每小时触发一次, 不会因 V8 时间漂移导致漏触发或双触发.

**Rationale**: Node.js 官方 timer 文档保证 ≥ 指定间隔; 即使偏差 ±200ms 对 7 天清理也无影响.

**Verification**: Task 11.1 `tests/events-cleanup.test.ts` 通过手工调用 cleanup 函数 + 伪造 `created_at` 验证清理语义; setInterval 本身作为 manual-verify (Task 11.2).

### A5: MCP SDK `@modelcontextprotocol/sdk` 会为每次 HTTP session 生成唯一 UUID 作为 session id

**Assumption**: SDK 暴露的 transport 抽象中, 每个 HTTP session 对应一个稳定 UUID, daemon 可以直接拿来当 `agent_id`.

**Rationale**: Streamable HTTP spec 要求 `Mcp-Session-Id` header; SDK 的 server 端 transport 生成该 id 并透传到 handler.

**Verification**: Task 4.1 `tests/mcp-transport.test.ts` 启动 daemon 发起两次 MCP HTTP 连接, 断言拿到两个不同 `Mcp-Session-Id` header 值.

### A6: JSONSchema diff 社区库 (`json-schema-diff-validator`) 的 `required` / `type` 变更检测符合 D7 breaking 规则

**Assumption**: 选定的 diff 库能正确识别 `required` 字段加减与 `type` 字符串变更, 供我们在包装层判定 breaking.

**Rationale**: 该库是 OpenAPI/JSONSchema 生态常用工具; 我们仅依赖它的原子 diff 输出, breaking 判定在我们的包装层做.

**Verification**: Task 9.2 `tests/contract-diff.test.ts` 覆盖"新增字段 / 删除字段 / required 反转 / type 变更"四个场景, 断言包装层输出 `breaking` 与 D7 规则一致.

### A7: daemon 启动时 `~/.ts-agent-teams/` 目录可写

**Assumption**: 当前用户对 `$HOME/.ts-agent-teams/` 有读写权限, 用来放 `daemon.pid` / `data.db` / `config.json`.

**Rationale**: daemon 是自用工具, 默认 HOME 目录下的 dotfile 是跨平台惯例.

**Verification**: accepted-risk — 罕见失败场景 (chroot / 权限异常), 启动 catch IO 异常后直接 stderr 报错退出即可.

## Migration Plan

项目是新建, 无旧版本迁移.  发布步骤:
1. `pnpm install` + 本地跑通所有 vitest 单测
2. `pnpm run build` (tsup 打包 ESM + CJS)
3. `tests/e2e-connectivity.test.ts` 本地跑过
4. 手动配置三家 agent 连 daemon, 手动跑 Phase 2 集成场景
5. `npm publish` (手动, MVP 不做 CI/CD)

Rollback: 本地单机工具, 用户直接不启动 daemon 即回滚; 配置文件手动删除 `~/.ts-agent-teams/`.

## Open Questions

1. **Phase 0 若只有部分 agent 支持 Streamable HTTP**: Plan B (stdio-proxy 子包) 是否在本 change 内实现?  当前计划: 若 Phase 0 e2e 通过则跳过 Plan B, 否则本 change 新增 `packages/stdio-proxy/` 子包 (task 10.x 备选).
2. **多 team 切换时 `events` 表清理是否 per-team**: 当前设计是全局 cleanup + team 过滤查询, 若未来跨 team agent 活跃度差异大再细化.
3. **Contract rollback / revert**: 本 change 不实现, Contracts 表保留所有历史, 用户自己 SQL 查回滚.
