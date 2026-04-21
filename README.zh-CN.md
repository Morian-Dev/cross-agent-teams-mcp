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

## Codex App-Server Delivery

如果你平时主要在 Codex 里使用, 更推荐直接调用 `register_codex_self`.  它会连接本地 Codex app-server, 调用 `thread/loaded/list`, 选择唯一可恢复的 thread, 然后把当前会话注册成 `codex-appserver` delivery.

最简用法:

```text
register_codex_self({
  name: "lead",
  team: "default",
  role: "worker"
})
```

如果本地不是默认地址, 可以显式覆盖 `ws_url`:

```text
register_codex_self({
  name: "lead",
  team: "default",
  role: "worker",
  ws_url: "ws://127.0.0.1:8799"
})
```

如果 app-server 开启了 Bearer token, 可以传 `auth_token_ref`, 它的值是 daemon 进程可见的环境变量名:

```text
register_codex_self({
  name: "lead",
  team: "default",
  role: "worker",
  auth_token_ref: "CODEX_REMOTE_TOKEN"
})
```

行为说明:

- 默认 `ws_url` 是 `ws://127.0.0.1:8799`
- 没有 loaded thread 时返回 `no_loaded_threads`
- 有多个可恢复 thread 时返回 `ambiguous_loaded_threads`
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
