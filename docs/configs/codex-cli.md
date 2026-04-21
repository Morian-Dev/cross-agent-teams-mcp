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

## 方案 1, 使用 tmux pane 作为 poke delivery

如果你运行 Codex CLI 的进程本身就在 tmux pane 里, 并且希望 `poke` 直接把文本注入当前 pane, 第一次 `register_agent` 时应该上报 `tmux_pane_id`.

先在 shell 里取 pane id.  优先用 `$TMUX_PANE`, 这是 tmux 按进程注入的可靠值:

    echo "$TMUX_PANE"

输出通常类似 `%42`.  不要把 `tmux display-message -p '#{pane_id}'` 当成首选, 它返回的是当前聚焦 pane, 多 agent 共用 session 时可能拿到别的 pane.  只有 `$TMUX_PANE` 为空时, 才把它当 fallback.

把结果传给 `register_agent`:

    register_agent({ model: "...", role: "...", team: "...", tmux_pane_id: "%42" })

如果你省略 `tmux_pane_id`, daemon 会在响应里附带一个 `hint`, 提醒你重新注册 pane id.  这个 hint 只针对依赖 tmux 的 delivery.  非 tmux delivery 不会收到这条提示.

## 方案 2, 使用 Codex app-server websocket delivery

如果你希望 daemon 通过 Codex 自带的 websocket app-server 唤醒一个正在运行的 Codex thread, 可以在 agent 侧启动 app-server, 然后把 `delivery.kind='codex-appserver'` 注册到 daemon.

优先推荐直接用高层工具 `register_codex_self`.  它会自动探测本地 app-server 上唯一可恢复的 loaded thread, 并把当前 agent 注册成 `codex-appserver` delivery.  同时它还会 best-effort 登记 `tmux_pane_id`: 显式传入的 pane id 优先, 否则会按 Codex matcher 尝试发现唯一 tmux pane.  只有在你需要精确指定 `thread_id` 或 `ws_url` 时, 才建议继续手写 `register_agent({ delivery: ... })`.

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
register_codex_self({
  name: "lead",
  team: "default",
  role: "worker"
})
```

如果你已经知道自己的 pane id, 可以直接传:

```text
register_codex_self({
  name: "lead",
  team: "default",
  role: "worker",
  tmux_pane_id: "%42"
})
```

如果调用工具的 shell pane 和可见的 Codex UI pane 可能不同, 可以传 hint 缩小探测范围:

```text
register_codex_self({
  name: "lead",
  team: "default",
  role: "worker",
  cwd: "/workspace/project",
  tty: "ttys026",
  title_contains: "project"
})
```

可选覆盖:

```text
register_codex_self({
  name: "lead",
  team: "default",
  role: "worker",
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

- `tmux_pane_id` 明确传入时会直接持久化
- 未传 `tmux_pane_id` 时, 工具会尝试按 Codex pane detector 写入唯一 pane
- `cwd`, `tty`, `title_contains` 只是 detector hint, 不会写入数据库
- detector 找不到唯一 pane 不会让注册失败, 只是这次不会更新 `tmux_pane_id`

如果没有可用 thread, 或有多个可恢复 thread, 工具会返回错误而不是擅自猜一个:

```json
{ "error": "no_loaded_threads" }
```

```json
{ "error": "ambiguous_loaded_threads", "detail": { "thread_ids": ["...", "..."] } }
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
