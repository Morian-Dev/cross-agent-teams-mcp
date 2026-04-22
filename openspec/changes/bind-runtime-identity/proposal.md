## Why

当前 `register_agent` 与 `register_codex_self` 会尝试在注册时自动探测 tmux pane。  这种做法在单实例场景下偶尔可用, 但在同仓库多 session, 同一 tmux session 多 agent, 或 helper 进程本身没有 tty 的情况下很容易误判或退化为 `NULL`.

这类 pane 绑定本质上需要更强的运行时标识, 例如 `ui_pid` 或 `ui_tty + tmux_pane_id`, 而不是让 daemon 从全局 pane 列表里猜测。  如果不把绑定路径改成显式校验, `tmux_pane_id` 会继续在真实多 agent 环境里不稳定, 进而影响 `poke` 和 auto-poke 的可靠性。

## What Changes

- 新增 `bind_runtime_identity` MCP tool, 允许已注册 agent 显式提交 `ui_pid` 或 `ui_tty + tmux_pane_id`, 由 daemon 校验后写入 `tmux_pane_id`。
- 为 `agents` 表新增 runtime 绑定元数据列, 记录 tty, pid, verification mode 与 bound time。
- 将 `register_agent` 从自动 tmux 探测改为纯 identity + delivery 注册, 不再在注册时写 pane。
- 将 `register_codex_self` 收窄为 Codex delivery 注册, 不再自动探测 tmux pane。
- 保留 `detect_tmux_pane` 作为调试工具, 但不再作为注册路径的隐式写入来源。

## Impact

- Affected specs: `agent-registry`, `codex-appserver-transport`
- Affected code: `src/mcp/tools.ts`, `src/mcp/register-codex-self.ts`, `src/storage/schema.ts`, `src/storage/agents-repo.ts`, new runtime binding helper and service, plus tests
