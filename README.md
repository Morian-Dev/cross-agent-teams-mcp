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

For opencode users who want server-based poke delivery (without relying on tmux), the first-class path is the **xats opencode launcher** (`launch-opencode.sh`).  The launcher creates an opencode server session, pre-registers the caller tmux pane with the xats daemon, and execs opencode so the daemon-side `opencode_base_url` / `opencode_session_id` metadata is auto-bound when opencode calls `register_opencode_self`.

### Recommended: launcher alias

Start the shared stack once (includes the opencode server on `http://127.0.0.1:4096`):

```bash
./start-server.sh
```

Then add an alias in your shell config.  The recommended name is `free-xats-opencode` so the original `opencode` command stays untouched — the xats-integrated variant is invoked explicitly:

```zsh
# ~/.zshrc
alias free-xats-opencode='/path/to/cross-agent-teams-mcp/launch-opencode.sh'
```

(If you prefer to shadow `opencode` itself, use `alias opencode='/path/...'` instead — but explicit opt-in is the safer default.)

Launch opencode from any tmux pane:

```bash
free-xats-opencode
```

Inside the opencode MCP session, register with the self-register helper — omit `base_url` / `session_id`, the launcher pre-reg auto-binds them:

```text
register_opencode_self({
  name: "my-opencode-agent",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
  role: "worker"
})
```

After registration, `poke()` routes to the opencode session via HTTP:

```json
{
  "ok": true,
  "transport_used": "opencode-server",
  "base_url": "http://127.0.0.1:4096",
  "session_id": "ses_xxxxx"
}
```

### Launcher requirements

- Must run inside tmux (`$TMUX_PANE` is required; the launcher exits with a clear error otherwise).
- The shared opencode server must be healthy (`./start-server.sh` brings it up; the launcher refuses to start otherwise).
- `cross-agent-teams-mcp` CLI must be on `$PATH` and the xats daemon must be running (the launcher calls `cross-agent-teams-mcp pre-register-opencode-pane` over HTTP).
- `base_url` is loopback-only (`127.0.0.1`, `localhost`, or `::1`).

### Version requirement (open question O1 resolved)

The launcher uses `opencode -s <session_id>` on the default TUI command to attach the interactive TUI to the pre-created server session.  This flag shipped on the default TUI command in **opencode 1.14.23**; the launcher auto-detects it via `opencode --help` at run time.  The pre-created session is pinned to the caller's `cwd` via `POST /session?directory=<encoded-cwd>` so the TUI can actually attach — if the pre-reg'd session lives in a different directory than the TUI's cwd, opencode silently forks its own session and the handshake breaks.

- `opencode >= 1.14.23`: launcher execs `opencode -s $SESSION_ID`, so the TUI renders the same server session the xats daemon is bound to.  `opencode-server` transport pokes (`POST /session/{id}/prompt_async`) land in the session the TUI is actively showing.
- `opencode < 1.14.23`: launcher falls back to plain `opencode` with a printed warning.  The interactive CLI creates its own orphan session; daemon HTTP pokes still succeed against the pre-reg'd server session but the TUI cannot see them, so wake-ups effectively fall back to tmux keystroke poke.

Upgrade opencode to 1.14.23 or newer to close this gap.  If you run the shared opencode server (`./start-server.sh`), also restart it after upgrading — the running process keeps the version it was started with.

### Advanced / custom: manual flow (no launcher)

For setups that cannot use the launcher (e.g., opencode is not launched from tmux, or a custom server session is required), the unified registration path still works:

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

Passing `base_url` and `session_id` explicitly **disables the pre-reg auto-bind path**; the explicit values take precedence and any concurrent pre-reg row for the caller's pane is ignored.

### Transport selection

Transport selection is client-aware:

- `client="claude-code"`: `claude-channel` first, then `tmux-poke`
- `client="opencode"`: `opencode-server` first, then `tmux-poke`
- `client="codex"`: `codex-appserver` first, then `tmux-poke`
