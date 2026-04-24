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
- `opencode-server`: send a prompt to an opencode session via HTTP

`register_agent(...)` now requires an explicit `client`.  Use one of `codex`, `claude-code`, or `opencode` for first-class runtimes.  For other agent harnesses, pass `client: "custom"` and optionally `client_name` for observability.

When you do not explicitly choose a `team`, pass `project_dir` as the caller's current working directory.  The daemon derives the default team from that directory's basename, and still falls back to `"default"` when both fields are omitted.

## Codex App-Server Delivery

For daily Codex usage, the recommended entry point is `register_agent({ client: "codex", ... })`.  It registers a caller-supplied `thread_id` as a `codex-appserver` delivery target through the unified registration API.  It does not auto-bind a tmux pane.  If you want tmux fallback delivery, call `bind_runtime_identity(...)` after registration.

`register_agent({ client: "codex", ... })` no longer guesses the caller's current thread from `thread/loaded/list`.  The daemon cannot safely infer "which loaded thread is mine" from the MCP session alone.  If `thread_id` is omitted, the tool returns `thread_id_required` with resumable thread ids for debugging instead of registering the wrong thread.

Minimal example:

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

If you also want tmux fallback routing, bind runtime identity explicitly after registration:

```text
bind_runtime_identity({
  agent: "codex",
  ui_pid: 81979
})
```

If you do not have the UI pid, you can fall back to `ui_tty + tmux_pane_id`:

```text
bind_runtime_identity({
  agent: "codex",
  ui_tty: "/dev/ttys026",
  tmux_pane_id: "%1902"
})
```

Override the websocket URL when needed:

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

If the app-server requires a Bearer token, pass `auth_token_ref` as an environment variable name visible to the daemon:

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

Behavior notes:

- `register_agent({ client: "codex", ... })` is the recommended entry point
- Default `ws_url` is `ws://127.0.0.1:8799`
- `thread_id` is required for successful registration
- tmux pane binding is handled separately by `bind_runtime_identity`
- `detect_tmux_pane(...)` remains available for debugging, but does not write registry state
- No loaded thread returns `no_loaded_threads`
- Omitted `thread_id` returns `thread_id_required` with resumable thread ids for debugging
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

## Claude Code Channel Delivery

For Claude Code sessions, prefer registering from the active MCP session with `register_claude_self(...)`.  If you do not explicitly choose a `team`, pass `project_dir` as the current working directory so the daemon derives the project team from its basename.

```text
register_claude_self({
  name: "lead",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
  role: "worker",
  channel_session_id: "csid-abc"
})
```

You can also use the unified entry point:

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

For a more complete Claude Code setup example, see [docs/configs/claude-code.md](docs/configs/claude-code.md).

## Opencode Delivery

For opencode users who want server-based poke delivery (without relying on tmux), the recommended path is `register_agent({ client: "opencode", base_url, session_id, ... })`.  This binds your agent row to an opencode server session so the daemon can deliver pokes via HTTP without a second tool call.

First, start opencode with a fixed port (omit `--port` to use the default random port):

```bash
opencode serve --port 4096
```

Then, in your opencode session, create a session and note its `id`:

```text
# The session id is shown when you create a session, or query via:
GET http://127.0.0.1:4096/session
```

Register your agent through the unified entry point:

```text
register_agent({
  client: "opencode",
  model: "anthropic/claude-3-5-sonnet-20241022",
  name: "my-opencode-agent",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
  role: "worker",
  base_url: "http://127.0.0.1:4096",
  session_id: "ses_xxxxx"
})
```

Requirements:

- `base_url` must be a loopback address (`127.0.0.1`, `localhost`, or `::1`)
- `session_id` is the opencode session identifier from the server
- The server only accepts loopback opencode endpoints for self-binding

On success, `poke()` will route to your opencode session via HTTP:

```json
{
  "ok": true,
  "transport_used": "opencode-server",
  "base_url": "http://127.0.0.1:4096",
  "session_id": "ses_xxxxx"
}
```

Transport selection is now client-aware:

- `client="claude-code"`: `claude-channel` first, then `tmux-poke`
- `client="opencode"`: `opencode-server` first, then `tmux-poke`
- `client="codex"`: `codex-appserver` first, then `tmux-poke`
