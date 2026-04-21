## Why

`register_codex_self` 目前把“注册当前 Codex 会话”实现成了“扫描 app-server 上所有 loaded threads, 然后猜一个唯一可恢复的 thread”。  这个推断没有调用者自己的 thread 身份信号, 在同机存在其他 Codex remote 会话时会错绑到别人的 thread, 甚至在 rollout 状态短暂不同步时表现成误导性的 `codex_resume_failed`.

## What Changes

- 修改 `register_codex_self` 的绑定语义: 不再根据 `thread/loaded/list` 自动猜测“当前 thread”.
- 为 `register_codex_self` 增加显式 `thread_id` 入参, 只有调用者明确提供 thread id 时才注册 `delivery.kind='codex-appserver'`.
- 当调用者未提供 `thread_id` 时, 工具仍可探测 app-server 的 loaded / resumable threads, 但只返回一个明确的“需要 thread_id”错误和可供排查的线程列表, 不执行注册.
- 更新工具描述, 文档, 测试和 spec, 明确 `register_codex_self` 的安全边界: daemon 无法凭当前 MCP session 推导出“调用者自己的 Codex thread”.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-registry`: `register_codex_self` 从“自动探测当前 thread”改为“要求显式 thread_id 或安全失败”, 避免跨会话误注册.

## Impact

- 实现: `src/mcp/register-codex-self.ts`, `src/mcp/tools.ts`
- 测试: `tests/register-codex-self.test.ts`, `tests/register-codex-self-tool-registration.test.ts`
- 文档: `README.md`, `README.zh-CN.md`, `docs/configs/codex-cli.md`
- OpenSpec: `openspec/specs/agent-registry/spec.md`
