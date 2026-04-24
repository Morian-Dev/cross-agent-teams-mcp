# cross-agent-teams-mcp

[English README](./README.md)

用于跨 agent 协作的 MCP daemon, 支持 tmux, Codex app-server 和 Claude channel wake 等本地投递方式.

## 快速开始

在仓库根目录执行:

```bash
pnpm build
node dist/cli.js daemon --port 9100
```

如果你希望一键启动当前项目需要的 daemon 和 Codex app-server, 可以直接用:

```bash
./start-server.sh
```

这个脚本会先执行 `pnpm build`, 然后再启动后台服务.  停止服务可以用:

```bash
./stop-server.sh
```

日志和 pid 文件会写到 `logs/` 目录.

如果你想直接跑源码, 可以用:

```bash
npx tsx src/cli.ts daemon --port 9100
```

服务默认监听 `127.0.0.1:9100`.  MCP endpoint 是 `http://127.0.0.1:9100/mcp`, 健康检查地址是 `http://127.0.0.1:9100/health`.

启动后可以用下面的命令确认服务正常:

```bash
curl http://127.0.0.1:9100/health
```

## 常用参数

- `--port <port>`: 指定监听端口, 默认 `9100`
- `--token <token>`: 开启 Bearer token 鉴权
- `--db <path>`: 指定 SQLite 数据库路径
- `--pid-file <path>`: 指定 pid 文件路径

默认数据目录是 `~/.cross-agent-teams-mcp/`.  默认数据库文件是 `~/.cross-agent-teams-mcp/data.db`, 默认 pid 文件是 `~/.cross-agent-teams-mcp/daemon.pid`.

如果已有实例在运行, 启动时会返回 `daemon already running pid=...`.

## 投递方式

当前 daemon 支持这些唤醒路径:

- `tmux_pane_id`: 直接把文本注入目标 tmux pane
- `delivery.kind='codex-appserver'`: 通过 websocket 恢复 Codex thread 并启动一轮 turn
- `delivery.kind='claude-channel'`: 绑定 Claude channel session 并发送 channel wake 通知
- `opencode-server`: 通过 HTTP 向 opencode session 发送 prompt

`register_agent(...)` 现在要求显式传 `client`.  一等运行时使用 `codex` / `claude-code` / `opencode`.  其它 agent harness 请传 `client: "custom"`, 并且可以选填 `client_name` 方便排查。

如果同时传了 `ui_pid`, `client` 必须描述这个 `ui_pid` 背后的真实 runtime, 不是当前发起 MCP 调用的宿主。  例如, 在 Claude Code 里替 opencode pane 做注册时, 也要传 `client: "opencode"`。

当用户没有显式指定 `team` 时, 调用方推荐传 `project_dir` 为当前工作目录.  daemon 会用该目录 basename 派生默认 team, 两者都不传时仍回落到 `"default"`.

## Codex App-Server Delivery

如果你平时主要在 Codex 里使用, 更推荐直接调用 `register_agent({ client: "codex", ... })`.  它会用调用者显式提供的 `thread_id` 把当前会话注册成 `codex-appserver` delivery, 同时保持统一入口.  它不会自动绑定 tmux pane.  如果你还需要 tmux 作为兜底唤醒路径, 请在注册成功后单独调用 `bind_runtime_identity(...)`.

`register_agent({ client: "codex", ... })` 不再根据 `thread/loaded/list` 去猜“当前调用者自己的 thread”.  daemon 仅凭 MCP session 无法安全判断 loaded threads 里哪一个属于当前调用者.  如果省略 `thread_id`, 工具会返回 `thread_id_required`, 并附带可恢复的 thread id 列表供排查, 但不会继续注册.

最简用法:

```text
register_agent({
  client: "codex",
  model: "gpt-5",
  name: "lead",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
  role: "worker",
  thread_id: "11111111-1111-4111-8111-111111111111"
})
```

如果你还需要 tmux fallback delivery, 在注册后显式绑定 runtime identity:

```text
bind_runtime_identity({
  agent: "codex",
  ui_pid: 81979
})
```

如果拿不到 UI pid, 可以退化到 `ui_tty + tmux_pane_id`:

```text
bind_runtime_identity({
  agent: "codex",
  ui_tty: "/dev/ttys026",
  tmux_pane_id: "%1902"
})
```

如果本地不是默认地址, 可以显式覆盖 `ws_url`:

```text
register_agent({
  client: "codex",
  model: "gpt-5",
  name: "lead",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
  role: "worker",
  thread_id: "11111111-1111-4111-8111-111111111111",
  ws_url: "ws://127.0.0.1:8799"
})
```

如果 app-server 开启了 Bearer token, 可以传 `auth_token_ref`, 它的值是 daemon 进程可见的环境变量名:

```text
register_agent({
  client: "codex",
  model: "gpt-5",
  name: "lead",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
  role: "worker",
  thread_id: "11111111-1111-4111-8111-111111111111",
  auth_token_ref: "CODEX_REMOTE_TOKEN"
})
```

行为说明:

- `register_agent({ client: "codex", ... })` 是新的推荐入口
- 默认 `ws_url` 是 `ws://127.0.0.1:8799`
- 成功注册必须显式提供 `thread_id`
- tmux pane 绑定需要单独调用 `bind_runtime_identity(...)`
- `bind_runtime_identity(...)` 的 `agent` 参数是必填, 用于选择内置进程匹配器
- 优先使用 `ui_pid`, 也支持 `ui_tty + tmux_pane_id` 的降级校验路径
- 没有 loaded thread 时返回 `no_loaded_threads`
- 省略 `thread_id` 时返回 `thread_id_required`, 并附带可恢复 thread id 列表供排查
- 成功时返回 `{ agent_id, team, thread_id, ws_url }`

Codex app-server 的最小启动方式:

```bash
codex app-server --listen ws://127.0.0.1:8799
codex --remote ws://127.0.0.1:8799
```

你也可以手动通过 `register_agent` 注册目标:

```text
register_agent({
  model: "...",
  name: "...",
  role: "...",
  team: "...",
  delivery: {
    kind: "codex-appserver",
    thread_id: "11111111-1111-4111-8111-111111111111",
    ws_url: "ws://127.0.0.1:8799"
  }
})
```

如果 app-server 开启了 Bearer token:

```text
register_agent({
  model: "...",
  name: "...",
  role: "...",
  team: "...",
  delivery: {
    kind: "codex-appserver",
    thread_id: "11111111-1111-4111-8111-111111111111",
    ws_url: "ws://127.0.0.1:8799",
    auth_token_ref: "CODEX_REMOTE_TOKEN"
  }
})
```

行为说明:

- `thread_id` 必须是 UUID
- `ws_url` 只能使用 `ws://` 或 `wss://`
- `auth_token_ref` 只会被解释为环境变量名
- 成功时, `poke()` 返回 `{ ok: true, transport_used: 'codex-appserver', thread_id }`
- 失败时, `poke()` 返回 machine-readable 错误, 例如 `codex_connect_failed`, `codex_initialize_failed`, `codex_resume_failed`, `codex_turn_start_failed`, `missing_auth_token`
- 当目标显式注册为 `codex-appserver` 时, daemon 不会自动 fallback 到 tmux

更完整的 Codex CLI 配置和启动示例见 [docs/configs/codex-cli.md](docs/configs/codex-cli.md).

## Claude Code Channel Delivery

如果你平时主要在 Claude Code 里使用, 更推荐直接在当前 Claude 会话里调用 `register_claude_self(...)`.  这条 helper 会把注册写到当前 host session 上, 可以直接避免外部 `curl` 注册带来的 session 错位。  如果当前 host 已经知道 channel proxy 宣告的 `channel_session_id`, 可以这样完成自注册和 channel 绑定:

```text
register_claude_self({
  name: "lead",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
  role: "worker",
  channel_session_id: "csid-abc"
})
```

如果你更想走统一入口, 也可以在当前 Claude 会话里直接调用 `register_agent({ client: "claude-code", ... })`:

```text
register_agent({
  client: "claude-code",
  model: "opus-4-7",
  name: "lead",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
  role: "worker",
  channel_session_id: "csid-abc"
})
```

行为说明:

- Claude Code 的 proxy session 不是 owner Claude session。  不要用外部 `curl` 代替当前 Claude 会话做注册, 否则后续工具调用仍然可能看到 `unknown_agent`
- `register_claude_self(...)` 是 Claude Code 的首选路径, 因为它天然运行在当前 session 上
- `client="claude-code"` 时, `poke` 会优先走 `claude-channel`, 失败后再回退到 `tmux`
- 如果注册响应里仍然带 `hint`, 说明 tmux fallback 还没有完成绑定, 这时调用 `bind_runtime_identity(...)`
- `bind_channel(...)` 仍然保留, 但它只是低层重绑工具, 适合已注册 row 在 proxy 切换到新 `channel_session_id` 后补绑

更完整的 Claude Code 配置见 [docs/configs/claude-code.md](docs/configs/claude-code.md).

## Opencode Delivery

如果你平时主要在 opencode 里使用, 更推荐直接调用 `register_agent({ client: "opencode", ... })`.  如果当前 host 已经知道本地 opencode server 的 `base_url` 和 `session_id`, 可以在统一入口里直接完成 opencode server 绑定:

```text
register_agent({
  client: "opencode",
  model: "anthropic/claude-3-5-sonnet-20241022",
  name: "worker-opencode",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
  role: "worker",
  base_url: "http://127.0.0.1:4096",
  session_id: "ses_xxxxx"
})
```

行为说明:

- `client="opencode"` 时, `poke` 会优先走 `opencode-server`, 失败后再回退到 `tmux`
- `base_url` 只能是 loopback 地址, 比如 `127.0.0.1`, `localhost`, `::1`
- 如果注册响应里仍然带 `hint`, 说明 tmux fallback 还没有完成绑定, 这时调用 `bind_runtime_identity(...)`
- `bind_opencode_session(...)` 仍然保留, 但它只是低层重绑工具, 适合已注册 row 在本地 session 变化后补绑

更完整的 opencode 配置见 [docs/configs/opencode.md](docs/configs/opencode.md).
