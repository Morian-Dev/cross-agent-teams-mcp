## Why

当前项目的 `poke` 仅支持 `claude-channel` 和 `tmux-poke`, 因而 opencode agent 只有在 tmux pane 内运行时才能被可靠唤醒。  但我们已经确认 opencode 自带 server/session API, 外部 client 可以直接向指定 session 注入一条 user message 并触发回复, 这更适合做当前项目的 `poke` transport.  

如果不把这条能力纳入 daemon, 用户就需要继续为 opencode 保留 tmux 依赖, 或手动在多个终端之间转发消息。  现在补上这个方案, 可以让 opencode 与 Claude Code 一样成为一等 delivery target, 并为后续 delivery abstraction 铺路。  

## What Changes

- 新增 `opencode-server-transport` capability, 定义 daemon 如何基于 opencode server/session metadata 向目标 agent 注入 poke prompt。
- 修改 `agent-interrupts`, 让 `poke` 在目标 agent 具备 opencode delivery metadata 时优先走 `opencode-server` transport, 并返回对应的成功 envelope。
- 新增自绑定工具, 让 opencode host 在完成 `register_agent` 后上报自己的 `base_url` 与 `session_id`, 使 daemon 能保存目标 session 的 delivery metadata。
- 定义 opencode transport 的失败语义, 包括 metadata 缺失, server 不可达, 目标 session 不存在, 以及目标 session 正忙时的处理边界。
- 补充设计约束, 明确本 change 不复用 Claude Code 的 `claude/channel` 协议, 而是走 opencode 官方 server/session 接口。

## Capabilities

### New Capabilities

- `opencode-server-transport`: 允许 daemon 通过 opencode 官方 server/session API, 向已注册的 opencode agent session 发送 poke prompt。

### Modified Capabilities

- `agent-interrupts`: 扩展 `poke` 的 transport 选择顺序, 成功返回格式, 以及 opencode transport 的错误行为。
- `agent-registry`: 为 `agents` 表和 `list_agents` 增加 opencode delivery metadata 的持久化与可见性。
- `mailbox`: 扩展 auto-poke 的 transport abstraction, 使 `send_message` / `broadcast` / `broadcast_to_role` 对 opencode target 也能走 server transport。

## Impact

- Affected specs: `openspec/specs/agent-interrupts/spec.md`, `openspec/specs/agent-registry/spec.md`, `openspec/specs/mailbox/spec.md`, new `openspec/specs/opencode-server-transport/spec.md`.
- Affected code: `src/mcp/poke.ts`, `src/mcp/transport-dispatch.ts`, `src/storage/schema.ts`, `src/storage/agents-repo.ts`, `src/mcp/tools.ts`, plus a new opencode client/helper module and binding service.
- Affected runtime contract: registered agents that want server-based opencode poke will need to self-bind their opencode session metadata, 不再只依赖 `tmux_pane_id`。
- External dependency surface: opencode server HTTP/session API, constrained to loopback base URLs in this change.
