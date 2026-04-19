## Why

当前 `send_message` 同时承载 "1→1 私聊" 和 "按 role 扇出" 两种语义, 与已有的 `broadcast` (团队全员) 形成概念混叠 — role 扇出本质上是广播, 不是私聊.  同时, 整个 mailbox 被硬约束在 "同 team" 内, 无法满足用户偶尔需要精确指定跨 team 对话的场景.

现在拆分:  `send_message` 收敛到 1→1 私聊, 广播类能力集中到 `broadcast` / `broadcast_to_role`, 并为 `send_message` 增加 `to_team` 参数以支持跨 team 直连.  跨 team 只允许精确点名 (to_agent_id), 不允许 role 扇出, 也没有全局广播 — 避免盲目的跨组织广播带来的权限 / 噪音问题.

## What Changes

- **BREAKING** `send_message` 去掉 `to_role` 参数, 只接受 `to_agent_id` — 退化为纯 1→1 私聊工具
- **BREAKING** `send_message` 新增可选 `to_team` 参数; 省略时默认发送方 team, 指定且不同于发送方 team 时触发跨 team 私聊 (auto-poke 仍生效)
- **BREAKING** `send_message` 工具描述明确: "除非用户明确指定 `to_team`, 不要跨 team 沟通"
- 新增 MCP 工具 `broadcast_to_role({to_role, body, subject?, auto_poke?})` — 同 team 内按 role 扇出; 永远不跨 team
- `broadcast` 语义不变 (同 team 全员除自己), 但其工具描述要与新的 `broadcast_to_role` / `send_message` 关系对齐
- **BREAKING** `messages` 表: 删 `team`, 加 `from_team TEXT NOT NULL` + `to_team TEXT NOT NULL` (`to_role` 保留, `broadcast_to_role` 继续写入)
- **BREAKING** `events` 表: 删 `team`, 加 `from_team TEXT NOT NULL` + `to_team TEXT NOT NULL`; 非跨 team 事件 `from_team == to_team`, 仅 `send_message` 跨 team 时两者不等
- **BREAKING** `events` 索引: 移除 `idx_events_team_eventid`, 新增 `idx_events_from_team_eventid` 和 `idx_events_to_team_eventid`
- **BREAKING** SSE fanout 过滤键从 `session.team === event.team` 改为 `session.team === event.to_team`
- `get_inbox` / offline-delivery 语义基于 `messages.to_agent_id`, 不受 team 拆分影响, 但查询 SQL 需更新字段名

## Capabilities

### New Capabilities

(无全新 capability; 新工具 `broadcast_to_role` 归入 `mailbox` spec)

### Modified Capabilities

- `mailbox`: 拆分 send_message / broadcast / broadcast_to_role, 加跨 team 私聊, schema 改为 from_team + to_team
- `events-outbox`: 事件表 schema 拆为 from_team + to_team, 索引重建, append 签名改变, since 过滤 by to_team

实现层面还会动 `mcp-transport` (SseFanout 过滤键改为 `event.to_team`) 和 `contract-subscriptions` (SSE 推送内部用 to_team), 但两者的 spec 级 Requirement 措辞保持不变 (fan-out 一直是 "to every session in that team", 对 contract_event 来说 from_team == to_team, 语义等价), 因此不生成 delta spec.

## Impact

- **代码**: `src/mcp/send-message.ts`, `src/mcp/broadcast.ts`, `src/mcp/tools.ts`, `src/mcp/transport.ts`, `src/daemon/sse-fanout.ts`, `src/storage/schema.ts`, `src/storage/events-outbox.ts`, `src/mcp/get-inbox.ts`, `src/mcp/auto-poke-fanout.ts`, `src/mcp/poke-retry.ts`
- **新增代码**: `src/mcp/broadcast-to-role.ts` (新 service)
- **测试**: 重写 / 迁移 `tests/send-role-broadcast.test.ts` → `tests/broadcast-to-role.test.ts`; 更新所有引用 `messages.team` / `events.team` 的测试 (粗估 20+ 文件, 多数是字段重命名)
- **spec**: mailbox / events-outbox / mcp-transport / contract-subscriptions 四个 spec 需 delta
- **数据库**: MVP 阶段 fresh-boot, 不做 migration — 下次启动直接采用新 schema, 旧数据丢弃 (与 `feedback_skip_legacy_db_migration.md` 一致)
- **MCP client**: 已部署的 agent 重启时拿到新 tool 列表, 任何依赖 `send_message({to_role})` 的 prompt / 自动化流程必须改写为 `broadcast_to_role({to_role})`
- **依赖**: 无新外部依赖
