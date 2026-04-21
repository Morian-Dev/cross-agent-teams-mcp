# cross-agent-teams-mcp

[中文说明](./README.zh-CN.md)

An MCP daemon for cross-agent collaboration, with local delivery transports for tmux, Codex app-server, and Claude channel wake integration.

## Quick Start

Build and start the daemon from the repository root:

```bash
pnpm build
node dist/cli.js daemon --port 9100
```

If you want a one-command local setup for the daemon and Codex app-server, use:

```bash
./start-server.sh
```

The script runs `pnpm build` first, then starts the background services.  To stop them:

```bash
./stop-server.sh
```

Logs and pid files are written into `logs/`.

To run directly from source:

```bash
npx tsx src/cli.ts daemon --port 9100
```

By default the daemon listens on `127.0.0.1:9100`.  The MCP endpoint is `http://127.0.0.1:9100/mcp`, and the health check endpoint is `http://127.0.0.1:9100/health`.

You can verify the service with:

```bash
curl http://127.0.0.1:9100/health
```

## Common Flags

- `--port <port>`: listening port, default `9100`
- `--token <token>`: enable Bearer token authentication
- `--db <path>`: SQLite database path
- `--pid-file <path>`: pid file path

The default data directory is `~/.cross-agent-teams-mcp/`.  The default database file is `~/.cross-agent-teams-mcp/data.db`, and the default pid file is `~/.cross-agent-teams-mcp/daemon.pid`.

If another instance is already running, startup returns `daemon already running pid=...`.

## Delivery Transports

The daemon currently supports these wake-up paths:

- `tmux_pane_id`: inject text directly into a target tmux pane
- `delivery.kind='codex-appserver'`: resume a Codex thread over websocket and start a turn
- `delivery.kind='claude-channel'`: bind a Claude channel session and deliver channel wake notifications

## Codex App-Server Delivery

For daily Codex usage, the recommended entry point is `register_codex_self`.  It connects to the local Codex app-server, calls `thread/loaded/list`, selects the single resumable thread, and registers the current session as a `codex-appserver` delivery target.  It also best-effort records `tmux_pane_id`: explicit `tmux_pane_id` wins, otherwise the tool tries to discover the Codex UI pane.

Minimal example:

```text
register_codex_self({
  name: "lead",
  team: "default",
  role: "worker"
})
```

If you already know the pane id, pass it directly:

```text
register_codex_self({
  name: "lead",
  team: "default",
  role: "worker",
  tmux_pane_id: "%42"
})
```

If the shell pane and the visible Codex UI may differ, you can narrow the best-effort pane lookup:

```text
register_codex_self({
  name: "lead",
  team: "default",
  role: "worker",
  cwd: "/workspace/project",
  title_contains: "project"
})
```

Override the websocket URL when needed:

```text
register_codex_self({
  name: "lead",
  team: "default",
  role: "worker",
  ws_url: "ws://127.0.0.1:8799"
})
```

If the app-server requires a Bearer token, pass `auth_token_ref` as an environment variable name visible to the daemon:

```text
register_codex_self({
  name: "lead",
  team: "default",
  role: "worker",
  auth_token_ref: "CODEX_REMOTE_TOKEN"
})
```

Behavior notes:

- Default `ws_url` is `ws://127.0.0.1:8799`
- `tmux_pane_id` is persisted when provided explicitly or when a unique Codex pane can be detected
- Optional pane-detect hints are `cwd`, `tty`, and `title_contains`
- Failure to find a unique tmux pane does not fail `register_codex_self`; it only means no new pane id is written
- No loaded thread returns `no_loaded_threads`
- Multiple resumable threads return `ambiguous_loaded_threads`
- Success returns `{ agent_id, team, thread_id, ws_url }`

Minimal Codex app-server startup:

```bash
codex app-server --listen ws://127.0.0.1:8799
codex --remote ws://127.0.0.1:8799
```

You can also register a target manually with `register_agent`:

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

If the app-server requires a Bearer token:

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

Behavior notes:

- `thread_id` must be a UUID
- `ws_url` must use `ws://` or `wss://`
- `auth_token_ref` is interpreted only as an environment variable name
- On success, `poke()` returns `{ ok: true, transport_used: 'codex-appserver', thread_id }`
- On failure, `poke()` returns machine-readable errors such as `codex_connect_failed`, `codex_initialize_failed`, `codex_resume_failed`, `codex_turn_start_failed`, or `missing_auth_token`
- When a target is explicitly registered as `codex-appserver`, the daemon does not fall back to tmux

For a more complete Codex CLI setup example, see [docs/configs/codex-cli.md](docs/configs/codex-cli.md).
