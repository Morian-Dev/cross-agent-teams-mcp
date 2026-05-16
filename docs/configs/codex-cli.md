# Codex CLI MCP config for cross-agent-teams-mcp

把下面配置加到 `~/.codex/config.toml`:

```toml
experimental_use_rmcp_client = true

[mcp_servers.cross-agent-teams-mcp]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
```

`experimental_use_rmcp_client = true` 必须放在**顶级**, 缺这条 codex 不会用 rmcp client, streamable-http 类型 MCP 加载不了.

如果 daemon 启动时带了 `--token`, **不要**用老写法 `[mcp_servers.X.headers]` —— Codex 0.130+ 不认 (会静默忽略, MCP 握手时被 daemon 401 拒掉, 然后 codex 把 401 body 当 JSON-RPC 帧解析失败, 报错 `Deserialize error: data did not match any variant of untagged enum JsonRpcMessage`).  正确写法用 `bearer_token_env_var` (推荐) 或 `http_headers`:

```toml
experimental_use_rmcp_client = true

[mcp_servers.cross-agent-teams-mcp]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
bearer_token_env_var = "XATS_TOKEN"  # codex 启动时会读 $XATS_TOKEN 作为 Bearer
```

启动 codex 的 shell 里要 `export XATS_TOKEN=<daemon 的 --token 值>`.  如果 codex 在 `--remote` 模式下跑, env 要在启动 **app-server** 的那个 shell 里 export, 不是 TUI shell (见 [docs/launchers/free-xats-codex.md](../launchers/free-xats-codex.md) 的 caveats).

> **--remote 模式下 MCP 是 app-server 加载的**, 不是 TUI 加载的.  如果你打算用下文的"方案 2 (codex app-server websocket delivery)", 上面这段配置必须放在 app-server 启动时读到的 `CODEX_HOME` 里 — 一般就是全局 `~/.codex/config.toml`.  仅在项目 `.codex/config.toml` 配, 或仅在 TUI 启动时覆盖 `CODEX_HOME=...`, 在 `--remote` 模式下对 MCP 不起作用.

## 推荐: `register_agent({ agent_type: "codex", thread_id, ... })`

Codex 0.124.0+ 在调用 MCP 工具时会向工具进程的环境变量里 export `CODEX_THREAD_ID`.  从 Codex agent 会话内, 直接调统一注册入口即可:

```text
register_agent({
  agent_type: "codex",
  name: "<agent-name>",
  thread_id: "<value of $CODEX_THREAD_ID>",
  project_dir: "<your project's absolute path>"
})
```

注意点:

- `thread_id` 是 codex 注册的必填项 (schema 层强制); 缺失或空字符串会被 Zod 拒绝
- 把 thread_id 注册成 `codex-appserver` delivery, app-server `ws_url` 默认 `ws://127.0.0.1:8799` (需要时用 `ws_url` 覆盖)
- `model` 可省略, 默认 `gpt`
- **不要传 `ui_pid`** — codex 的 launcher 通过 `pre_register_codex_pane` 走另一条 pre-reg 流程做 tmux pane 自动绑定, 显式传 `ui_pid` 反而会关掉那条路径
- `team` 默认从 `project_dir` 的 basename 派生, 想要不同 team 才显式传

成功响应:

```json
{ "agent_id": "...", "team": "...", "thread_id": "...", "ws_url": "ws://127.0.0.1:8799" }
```

后续 `poke` 走 `codex-appserver` transport (websocket 直接进对方 thread 里 start a turn).

下面"方案 1 / 方案 2"是更底层的入口和历史用法, 一般不需要.

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

优先推荐直接用统一入口 `register_agent`, 并显式带上 `agent_type: "codex"` 和 `thread_id`.  它会把你显式提供的 `thread_id` 注册成 `codex-appserver` delivery, 但不会自动绑定 tmux pane.  如果你还需要 tmux fallback delivery, 再单独调用 `bind_runtime_identity(...)`.

`register_agent({ agent_type: "codex", ... })` 不会再根据 loaded threads 自动猜“当前调用者自己的 thread”.  daemon 没有协议级信号把当前 MCP 调用者和某个 Codex loaded thread 强绑定.  如果你省略 `thread_id`, 工具会返回 `thread_id_required`, 并把当前可恢复的 thread ids 放在 detail 里供排查, 但不会继续注册.

### 1. 启动 app-server

本地 loopback, 无鉴权:

```bash
codex app-server --listen ws://127.0.0.1:8799
```

启动时不带 `CODEX_HOME` 的话, app-server 读全局 `~/.codex/config.toml`.  确保那份配置里**已经配了** `cross-agent-teams-mcp` MCP (见本文档开头), 否则 `--remote` 接进来的 codex agent 看不到 xats 的工具, `register_agent` 调不到, codex-appserver delivery 等于没装上.

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
  agent_type: "codex",
  model: "gpt-5",
  name: "lead",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
  role: "worker",
  thread_id: "11111111-1111-4111-8111-111111111111"
})
```

可选覆盖:

```text
register_agent({
  agent_type: "codex",
  model: "gpt-5",
  name: "lead",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
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
  "team": "cross-agent-teams-mcp",
  "thread_id": "11111111-1111-4111-8111-111111111111",
  "ws_url": "ws://127.0.0.1:8799"
}
```

补充说明:

- `register_agent({ agent_type: "codex", ... })` 是新的推荐入口
- 未显式指定 `team` 时, 推荐传 `project_dir` 为当前工作目录, daemon 会用目录名派生默认 team
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
