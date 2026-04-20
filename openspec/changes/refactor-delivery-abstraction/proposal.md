## Why

当前 `agents` 表只有一列 `channel_session_id: TEXT?` 表示"该 agent 接收 poke 的通道句柄", 列名和语义都绑死在 Claude Code 的 `claude/channel` experimental capability 上.  在即将接入 Codex app-server (以及未来其他 harness) 时, 这个单列模型无法承载"投递后端不同 + 句柄形状不同 (threadId + ws_url + auth_token_ref vs. 单个 session id)"的差异; 同时当前的身份注册是 `register_agent`, 通道绑定是 `bind_channel`, 两步分离也导致 Codex 接入必须各走一次注册, 而它本可一步完成.  把"投递通道"抽象为一等概念 `DeliverySpec`, 并把绑定并入 `register_agent`, 既为多后端让路, 也收敛注册入口.

## What Changes

- 引入新 capability `agent-delivery`, 定义 `DeliverySpec` 抽象: `{ kind: "claude-channel" | "codex-appserver" | "none", payload: <kind-specific> }`.  payload 形状由 kind 决定, 未来新增 kind 不改表结构.
- `agents` 表 schema: 新增 `delivery_kind TEXT NOT NULL DEFAULT 'none'` 和 `delivery_payload TEXT` (JSON 字符串) 两列.  **BREAKING** (storage schema): 旧 `channel_session_id` 列的语义被 `delivery_*` 取代.  本 change 不删旧列, 仅在迁移里把 `channel_session_id` 非 NULL 的行回填到 `delivery_kind='claude-channel', delivery_payload=JSON({channel_session_id})`; 旧列保留为 read-only 视图在下一个 change (out of scope) 再删.
- `register_agent` MCP tool 新增可选字段 `delivery: DeliverySpec`.  当提供时, 在同一事务内写入身份行 + delivery 字段.
- `bind_channel` MCP tool 保留, 但行为变为 "更新已注册 agent 的 delivery 字段到 `kind='claude-channel'`"; 在 proposal 兼容层中继续可用, 标记为 deprecated, 移除安排在下一个 change.
- `list_agents` 返回项新增 `delivery: DeliverySpec | null` 字段.  为过渡期兼容保留 `channel_session_id` 字段, 当 `delivery.kind === 'claude-channel'` 时从 payload 派生填充, 其他情况为 `null`.
- poke 分派路径按 `delivery.kind` 分流: `claude-channel` 走现有 `ChannelWakeFanout`; `none` 回退到 tmux 或 `no_transport_available` 错误.  `codex-appserver` 分派器在本 change **不实现**, 留待下一个 change `add-codex-appserver-delivery`.

## Capabilities

### New Capabilities

- `agent-delivery`: 定义投递通道抽象 `DeliverySpec`.  规定表存储形状 (`delivery_kind`, `delivery_payload`) 的持久化契约, kind 的全集, 每种 kind 的 payload schema (JSON), 以及 poke 分派器按 kind 选择后端的行为.  不规定具体后端的协议细节 — 那是各 transport spec 的事.

### Modified Capabilities

- `agent-registry`: `agents` 表 schema 新增 `delivery_kind` / `delivery_payload` 两列; `channel_session_id` 列在本 change 被标记为 legacy 派生列 (仅从 delivery 字段读取填充, 不再独立写入); `register_agent` 接受 `delivery` 字段; `list_agents` 返回项新增 `delivery` 字段.
- `claude-channel-transport`: `bind_channel` 的写入目标从"agents.channel_session_id 列"改为"agents.delivery_kind='claude-channel', delivery_payload 写入 JSON { channel_session_id }".  对外行为 (bind_channel 入参 / 出参 / ChannelWakeFanout 的 attach 语义) 不变; 仅底层写入路径变.

## Impact

- **存储层**: `src/storage/schema.ts` (增加两列 + 迁移), `src/storage/agents-repo.ts` (新字段读写 + 派生 `channel_session_id` 兼容访问器).
- **MCP tools**: `src/mcp/register-agent.ts` (接受 delivery), `src/mcp/tools.ts` 中的 `bind_channel` 和 `list_agents` 实现.
- **Daemon 分派**: poke 路径现有的 "读 channel_session_id → 走 ChannelWakeFanout" 改为 "读 delivery → 按 kind 分派".
- **测试**: `tests/` 下凡涉及 `channel_session_id` 的 schema / repo / register-agent / bind-channel / list-agents 测试需更新断言; 新增 DeliverySpec 的形状 / kind 分派 / 迁移回填测试.
- **插件**: `plugins/cross-agent-teams-channel` 的 daemon-client 调用入口不变 (仍走 bind_channel), 不需要改.
- **Out of scope**: Codex app-server 分派器实现 (下一 change); 删除旧 `channel_session_id` 列 (再下一 change); 用 `register_agent.delivery` 字段替换 `bind_channel` 的调用链 (并入 Codex 接入 change).
