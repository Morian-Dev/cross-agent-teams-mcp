# Codex CLI MCP config for cross-agent-teams-mcp

把下面配置加到 `~/.codex/config.toml`:

```toml
[mcp_servers.cross-agent-teams-mcp]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
```

如果 daemon 启动时带了 `--token`:

```toml
[mcp_servers.cross-agent-teams-mcp]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
[mcp_servers.cross-agent-teams-mcp.headers]
Authorization = "Bearer YOUR_TOKEN"
```

## 方案 1, 使用 tmux 作为兜底 delivery

`register_agent` 现在会在 identity 注册成功后, 对已识别的本地客户端 best-effort 自动尝试 runtime 绑定, 这样 tmux poke 通常不需要再多调一次工具。  调用方也不再向 `register_agent` 传 `tmux_pane_id`.

如果注册成功但响应里仍然带了 `hint`, 说明这次自动 runtime 绑定没有收敛, 当前还没有可用的 `tmux_pane_id`.  这时调用 `bind_runtime_identity(...)` 完成显式绑定.  `detect_tmux_pane(...)` 只作为调试工具, 不再负责写 registry.

如果你的 Codex 使用场景是“模型自己调用 MCP 工具”, 而不是外部客户端包装自动传参, 一个稳定的本地兜底方案是直接运行仓库里的注册脚本:

```bash
node scripts/register-codex-self.mjs --name gpt --team default --role default --model gpt-5
```

这个脚本会先读取当前 tmux pane 的 tty, 再在该 tty 上定位真实 Codex UI 进程 pid, 最后把 `ui_pid` 一起带进 `register_agent`.  对多 Codex pane 并行的场景, 这比只靠 `detect_tmux_pane({ agent: "codex" })` 更稳.

## 方案 2, 使用 Codex app-server websocket delivery

如果你希望 daemon 通过 Codex 自带的 websocket app-server 唤醒一个正在运行的 Codex thread, 可以在 agent 侧启动 app-server, 然后把 `delivery.kind='codex-appserver'` 注册到 daemon.

优先推荐直接用统一入口 `register_agent`, 并显式带上 `client: "codex"` 和 `thread_id`.  它会把你显式提供的 `thread_id` 注册成 `codex-appserver` delivery, 但不会自动绑定 tmux pane.  如果你还需要 tmux fallback delivery, 再单独调用 `bind_runtime_identity(...)`.

`register_agent({ client: "codex", ... })` 不会再根据 loaded threads 自动猜“当前调用者自己的 thread”.  daemon 没有协议级信号把当前 MCP 调用者和某个 Codex loaded thread 强绑定.  如果你省略 `thread_id`, 工具会返回 `thread_id_required`, 并把当前可恢复的 thread ids 放在 detail 里供排查, 但不会继续注册.

### 1. 启动 app-server

本地 loopback, 无鉴权:

```bash
codex app-server --listen ws://127.0.0.1:8799
```

如果你需要显式 bearer token, 先准备一个环境变量, 再让 app-server 和 TUI 都引用它:

```bash
export CODEX_REMOTE_TOKEN="replace-me"
codex app-server --listen ws://127.0.0.1:8799 --ws-auth capability-token
```

### 2. 让 Codex TUI 连接到同一个 app-server

无鉴权:

```bash
codex --remote ws://127.0.0.1:8799
```

带 token:

```bash
codex --remote ws://127.0.0.1:8799 --remote-auth-token-env CODEX_REMOTE_TOKEN
```

进入 TUI 后先发一条消息, 让它进入一个现有 thread.  `register_agent` 需要你显式提供这个 thread 的 `thread_id`.

### 3. 用 `register_agent` 上报 `delivery`

更简单的推荐用法:

```text
register_agent({
  client: "codex",
  model: "gpt-5",
  name: "lead",
  team: "default",
  role: "worker",
  thread_id: "11111111-1111-4111-8111-111111111111"
})
```

可选覆盖:

```text
register_agent({
  client: "codex",
  model: "gpt-5",
  name: "lead",
  team: "default",
  role: "worker",
  thread_id: "11111111-1111-4111-8111-111111111111",
  ws_url: "ws://127.0.0.1:8799",
  auth_token_ref: "CODEX_REMOTE_TOKEN"
})
```

返回:

```json
{
  "agent_id": "...",
  "team": "default",
  "thread_id": "11111111-1111-4111-8111-111111111111",
  "ws_url": "ws://127.0.0.1:8799"
}
```

补充说明:

- `register_agent({ client: "codex", ... })` 是新的推荐入口
- `bind_runtime_identity` 才是写入 `tmux_pane_id` 的路径
- `detect_tmux_pane(...)` 仅用于调试

如果没有 loaded thread, 工具会返回:

```json
{ "error": "no_loaded_threads" }
```

如果你省略 `thread_id`, 工具会返回:

```json
{ "error": "thread_id_required", "detail": { "ws_url": "ws://127.0.0.1:8799", "thread_ids": ["..."] } }
```

如果你仍然想手动指定 `delivery`, 可以继续用下面这种低层方式:

无鉴权:

```text
register_agent({
  model: "...",
  role: "...",
  team: "...",
  name: "...",
  delivery: {
    kind: "codex-appserver",
    thread_id: "11111111-1111-4111-8111-111111111111",
    ws_url: "ws://127.0.0.1:8799"
  }
})
```

带 token 引用:

```text
register_agent({
  model: "...",
  role: "...",
  team: "...",
  name: "...",
  delivery: {
    kind: "codex-appserver",
    thread_id: "11111111-1111-4111-8111-111111111111",
    ws_url: "ws://127.0.0.1:8799",
    auth_token_ref: "CODEX_REMOTE_TOKEN"
  }
})
```

约束:

- `thread_id` 必须是 UUID.
- `ws_url` 只能是 `ws://` 或 `wss://`.
- `auth_token_ref` 是环境变量名, 不是文件路径.  daemon 会读取 `process.env[auth_token_ref]`, 缺失或空白会直接返回 `missing_auth_token`.
- 当你显式提供 `codex-appserver` delivery 时, `register_agent` 不会再返回 tmux hint.

### 4. `poke` 的返回

Codex transport 成功时, `poke` 返回:

```json
{ "ok": true, "transport_used": "codex-appserver", "thread_id": "11111111-1111-4111-8111-111111111111" }
```

失败时会返回 transport-aware 错误, 例如:

```json
{ "error": "codex_connect_failed", "detail": "ECONNREFUSED", "transport_used": "codex-appserver" }
```

`codex-appserver` 是显式 delivery.  如果 websocket 连接或远端 RPC 失败, daemon 不会自动 fallback 到 tmux.
