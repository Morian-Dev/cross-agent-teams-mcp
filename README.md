# cross-agent-teams-mcp

[中文说明](./README.zh-CN.md)

An MCP daemon for cross-agent collaboration, with local delivery transports for tmux, Codex app-server, and Claude channel wake integration.

## Quick Start

This package ships a single long-running HTTP daemon.  You start it once on your machine, then point Claude Code / Codex / opencode at it as an MCP server.  There is no stdio entry point and no "auto bootstrap" — start the daemon explicitly first, agents connect to it second.

### 1. Start the daemon

```bash
npx -y cross-agent-teams-mcp@latest daemon --port 9100
```

Keep this process running (a dedicated terminal, `tmux`, `screen`, or your favourite supervisor).  The daemon listens on `127.0.0.1:9100` by default.  The MCP endpoint is `http://127.0.0.1:9100/mcp` and the health check endpoint is `http://127.0.0.1:9100/health`.

You can verify the service with:

```bash
curl http://127.0.0.1:9100/health
```

### 2. Configure your agent's MCP client

Point your agent at the running daemon over Streamable HTTP.  For Claude Code (`~/.claude.json` or `.mcp.json`):

```json
{
  "mcpServers": {
    "cross-agent-teams": {
      "type": "http",
      "url": "http://127.0.0.1:9100/mcp"
    }
  }
}
```

For Codex CLI, see [docs/configs/codex-cli.md](docs/configs/codex-cli.md).  For opencode see the "Using opencode with xats (tmux)" section below.

If you started the daemon with `--token <t>`, add `"headers": { "Authorization": "Bearer <t>" }` to the client configuration.

### 3. Register from inside the agent

Once the agent's MCP client is connected, register from inside the agent session — see `register_claude_self`, `register_codex_self`, and `register_agent` below.

### Running from source

If you cloned this repo and want to run the daemon from source:

```bash
pnpm install
pnpm build
node dist/cli.js daemon --port 9100
# or, without a build step:
npx tsx src/cli.ts daemon --port 9100
```

`./start-server.sh` / `./stop-server.sh` are local-development convenience scripts that also bring up a Codex app-server alongside the daemon; they are not needed when consuming this package via `npx`.

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

## Using opencode with xats (tmux)

opencode integrates with xats as a plain tmux-hosted TUI.  There is no dedicated launcher and no HTTP transport — pokes are delivered by pasting into the opencode pane via tmux, exactly the same path used for `client: "custom"`.

Start opencode inside a tmux window, then register from within opencode's MCP session:

```bash
tmux new-window opencode
```

```text
register_agent({
  client: "opencode",
  model: "opencode-default",
  name: "my-opencode-agent",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
  role: "worker",
  ui_pid: <opencode pid>
})
```

Pass the opencode process pid as `ui_pid`.  The daemon resolves `pid → tty → tmux pane` and populates `tmux_pane_id` in the same registration call.  After registration, pokes from other agents route to the opencode pane as `transport_used: "tmux-poke"`.

### Transport selection

Transport selection is client-aware:

- `client="claude-code"`: `claude-channel` first, then `tmux-poke`
- `client="opencode"`: `tmux-poke`
- `client="codex"`: `codex-appserver` first, then `tmux-poke`

### Operator cutover

If you are upgrading from a version that shipped the `opencode-server` transport:

1. Stop the daemon with `./stop-server.sh` (this wipes `data.db` on purpose — the dropped `opencode_base_url` / `opencode_session_id` columns and the `opencode_pane_pre_registrations` table are not migrated).
2. Rebuild: `pnpm build`.
3. Restart with `./start-server.sh`.
4. Remove any shell alias that pointed at `launch-opencode.sh` (the script no longer exists).
5. Re-register opencode agents using the `register_agent({ client: "opencode", ui_pid, ... })` flow shown above.
