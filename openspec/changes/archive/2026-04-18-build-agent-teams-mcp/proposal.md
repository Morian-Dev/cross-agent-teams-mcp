## Why

多个 code agent (opencode + GLM-5.1, Claude Code + Opus 4.6, Codex CLI + GPT-5.4) 并行开发同一项目时, 各 agent 彼此盲视. 用户被迫当"中间人"手动转述上下文 (典型例: 后端改了 API schema, 前端 agent 毫不知情).  本 change 构建一个本地 MCP daemon, 让三家 agent 通过同一个 MCP server 通信, 首要楔子是前后端契约同步.

## What Changes

- **新增 npm 包 `ts-agent-teams`**: TypeScript + Fastify 实现的本地 MCP daemon, 通过 `npx ts-agent-teams daemon` 启动.
- **新增 MCP Streamable HTTP transport 端点**: `127.0.0.1:9100` (端口递增 fallback), 供三家 agent 通过同一 URL 注册与通信; 可选 `--token` bearer 鉴权.
- **新增 agent 身份 / 消息 / 任务 / 契约四类 MCP tool**: `register_agent`, `list_agents`, `send_message`, `broadcast`, `get_inbox`, `task_add`, `task_claim`, `task_complete`, `task_list`, `register_contract`, `subscribe_contract`, `get_contract`, `diff_contracts`, `pending_contract_events`, `echo`.
- **新增 SQLite 持久化层**: 统一 outbox 表 `events` + 当前态表 `agents` / `messages` / `tasks` / `contracts`; 所有发布事件走同一 events 表, client 侧用 `event_id` cursor 去重.
- **新增 SSE push 通道**: 在线订阅者推送契约变更事件, 离线补齐走 `pending_contract_events` polling.
- **新增多 team 作用域**: 所有表携带 `team` 列, human 在 MCP server config 里指定 team 实现跨项目隔离.
- **新增三家 agent 的配置示例**: docs/configs/ 下放 opencode / Claude Code / Codex CLI 连接 daemon 的 JSON 片段.

## Capabilities

### New Capabilities
- `daemon-core`: Fastify HTTP daemon 生命周期 — 启动 / 端口选择 / PID 文件 / 127.0.0.1 绑定 / 优雅停止 / storage_unavailable 错误路径 / 可选 bearer token 鉴权.
- `mcp-transport`: MCP Streamable HTTP transport 挂载 + `echo` tool + Phase 0 三家 agent 连通性验证.
- `events-outbox`: `events` 表 schema, event_id 单调递增, team-scoped fan-out, 7-day cleanup 带"未被所有 client 确认消费"安全边界.
- `agent-registry`: `agents` 表, `register_agent` / `list_agents`, MCP session UUID 碰撞 409, last_seen_at 更新.
- `mailbox`: `messages` 表投影, `send_message` (to_agent_id / to_role), `broadcast` (不含发送者), `get_inbox` since_event_id cursor 翻页.
- `task-list`: `tasks` 表, `task_add`, `task_claim` 单语句 CAS (已认领返回 owner, depends_on 未完成不可认领), `task_complete` (非 claimer 返回 not_owner), `task_list` 按状态过滤.
- `contract-registry`: `contracts` 表 (保留历史版本), `register_contract` JSONSchema + 事务串行化 version 递增, `get_contract`, `diff_contracts` 深度 diff + JSON Pointer, breaking 判定规则.
- `contract-subscriptions`: `subscribe_contract` 持久化订阅, `pending_contract_events` polling, SSE fanout 通道 (在线 push + 离线补齐).

### Modified Capabilities
<!-- 空: 这是全新项目, 无现存 spec -->

## Impact

- **新代码库**: `package.json`, `src/daemon/`, `src/mcp/`, `src/storage/`, `tests/`.
- **新依赖**: `@modelcontextprotocol/sdk`, `fastify`, `better-sqlite3`, `zod`; dev 依赖 `vitest`, `tsup`, `typescript`, `@types/node`, `@types/better-sqlite3`.
- **新运行时文件**: `~/.ts-agent-teams/daemon.pid`, `~/.ts-agent-teams/config.json`, `~/.ts-agent-teams/data.db` (SQLite, 开启 WAL).
- **新文档**: `docs/configs/opencode.md`, `docs/configs/claude-code.md`, `docs/configs/codex-cli.md`, `README.md`.
- **外部生态**: 不改三家 agent 本身, 仅要求它们支持 MCP Streamable HTTP spec (2025 官方). Phase 0 失败则回落 stdio-proxy Plan B.
