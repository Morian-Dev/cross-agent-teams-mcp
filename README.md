# cross-agent-teams-mcp

[中文说明](./README.zh-CN.md)

A local MCP daemon that lets multiple AI coding agents (Claude Code, Codex, opencode) running on the same machine talk to each other.  Agents register, send 1-to-1 messages, broadcast to a team or role, queue shared tasks, and wake each other up — all over a single daemon, no external services.

## What's in the npm package

`cross-agent-teams-mcp` ships two bins from the same package:

- **`cross-agent-teams-mcp daemon`** — the long-running HTTP daemon.  Stores agents, mailboxes, and the task list in a local SQLite file, exposes its tools at `http://127.0.0.1:9100/mcp`.
- **`cross-agent-teams-channel`** — a stdio MCP shim that lets Claude Code receive `notifications/channel_wake` from the daemon (Claude Code's experimental channel capability).  Required for Claude Code wake-ups; not needed for Codex (which uses its own app-server transport) or opencode (which falls back to tmux-pane injection).

## 1. Start the daemon

Run this once on your machine and keep the process alive (dedicated terminal, `tmux`, `screen`, `launchd` — your call):

```bash
npx -y cross-agent-teams-mcp@latest daemon --port 9100
```

The daemon listens on `127.0.0.1:9100`.  MCP endpoint is `http://127.0.0.1:9100/mcp`, health endpoint is `http://127.0.0.1:9100/health`.

Common flags:

- `--port <n>` (default `9100`)
- `--token <t>` (Bearer auth)
- `--db <path>` (default `~/.cross-agent-teams-mcp/data.db`)
- `--pid-file <path>` (default `~/.cross-agent-teams-mcp/daemon.pid`)

## 2. Configure your agent's MCP client

### Claude Code (needs both entries — HTTP for tools, stdio for channel wake)

`.mcp.json` (or `~/.claude.json`):

```json
{
  "mcpServers": {
    "cross-agent-teams": {
      "type": "http",
      "url": "http://127.0.0.1:9100/mcp"
    },
    "cross-agent-teams-channel": {
      "command": "npx",
      "args": [
        "-y",
        "-p",
        "cross-agent-teams-mcp@latest",
        "cross-agent-teams-channel",
        "--daemon-url",
        "http://127.0.0.1:9100/mcp"
      ]
    }
  }
}
```

Then start Claude Code with the experimental channel loader so it subscribes to the proxy's wake notifications:

```bash
claude --dangerously-load-development-channels server:cross-agent-teams-channel
```

The `server:<name>` suffix MUST equal the MCP server key in `.mcp.json` (`cross-agent-teams-channel` above).  If your daemon uses `--token <t>`, add `"headers": { "Authorization": "Bearer <t>" }` to the HTTP entry.

### Codex CLI

Codex talks to the daemon directly over Streamable HTTP.  No channel proxy is needed — Codex has no `claude/channel` capability, and wake-ups are delivered via Codex's own app-server websocket transport (or tmux paste fallback).

`~/.codex/config.toml`:

```toml
[mcp_servers.cross-agent-teams]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
```

(daemon with `--token <t>`: add `[mcp_servers.cross-agent-teams.headers]` and `Authorization = "Bearer <t>"`.)

If you want other agents to be able to **wake** this Codex thread (not only mail it), start Codex's app-server alongside Codex itself:

```bash
codex app-server --listen ws://127.0.0.1:8799     # in one terminal
codex --remote ws://127.0.0.1:8799                # in another terminal (TUI)
```

Without an app-server, `send_message` to this Codex still queues a mailbox row, but you have to call `get_inbox` yourself to read it — there is no push to wake the thread.

Detailed config (auth headers, tmux fallback, lower-level `register_agent` form): [docs/configs/codex-cli.md](docs/configs/codex-cli.md).

### opencode

opencode connects directly over Streamable HTTP for tools.  It has no dedicated wake-up transport in this daemon (the previous `opencode-server` transport was removed); cross-agent pokes are delivered to opencode by injecting text into its tmux pane.  Run opencode inside a tmux window and the daemon will resolve `pid → tty → pane` automatically when you register.  See [docs/configs/opencode.md](docs/configs/opencode.md).

## 3. Register and communicate from inside the agent

Once your agent's MCP client is connected, run the registration helpers from inside the agent session — never from `curl` or another external HTTP client (that creates a different MCP session and breaks delivery).

### Register

`register_agent` is the single registration entry point.  Decide `agent_type=` mechanically before calling, in order — first match wins:

1. `printenv CODEX_THREAD_ID` non-empty → `agent_type="codex"`; pass that value as `thread_id` (REQUIRED).  Do NOT pass `ui_pid` (the launcher's `pre_register_codex_pane` flow handles tmux pane binding).
2. `printenv CLAUDECODE` non-empty OR `printenv CLAUDE_CODE_ENTRYPOINT` non-empty → `agent_type="claude-code"`; pass `$PPID` as `ui_pid`.
3. None of the above → `agent_type="custom"` with `agent_type_name="<your harness name, e.g. cursor, opencode, ...>"`.  Detect the harness name from your runtime environment when you can — for example, `printenv CURSOR_TRACE_ID` non-empty is a cursor signal — but do NOT guess from system-wide signals like "binary X exists on PATH": those reflect what the user has installed, not what runtime you are inside, and produce wrong agent types.  When unsure, prefer `agent_type_name="unknown"` over a wrong guess.

Codex:

```text
register_agent({
  agent_type: "codex",
  name: "<agent-name>",
  thread_id: "<value of $CODEX_THREAD_ID>",
  project_dir: "<your project's absolute path>"
})
```

Claude Code:

```text
register_agent({
  agent_type: "claude-code",
  name: "<agent-name>",
  ui_pid: <Claude Code CLI pid; in a Bash tool call this is $PPID>,
  project_dir: "<your project's absolute path>"
})
```

Other harnesses (cursor, opencode, an editor extension, an unknown caller):

```text
register_agent({
  agent_type: "custom",
  agent_type_name: "<your harness name>",  // required when agent_type="custom"
  name: "<agent-name>",
  project_dir: "<your project's absolute path>",
  ui_pid: <runtime pid>          // strongly recommended for tmux poke delivery
})
```

`model` is OPTIONAL for any `agent_type`; omit it when you do not have an authoritative model identifier (the daemon stores NULL).  `team` defaults to the basename of `project_dir`; pass it explicitly only when you want a different team.  On success Claude Code registrations include `channel_session_id` in the response — that means wake delivery is wired up automatically.

`agent_type="opencode"` is still accepted as an explicit value for opencode-aware launchers, but no detection probe promotes it: opencode being installed does NOT mean the LLM you are running is inside opencode.

### Send messages and inspect inbox

```text
send_message({ to_agent_name: "<other-agent>", subject: "...", body: "..." })
broadcast({ subject: "...", body: "..." })            // same team
broadcast_to_role({ role: "<role>", subject, body })  // same team, same role
get_inbox()                                            // your own messages
```

`send_message` auto-pokes the recipient with a short wake-up hint; bodies are read via `get_inbox`.  Reply expectations are signalled by `need_reply` (default `true`).  Address by UUID with `send_message_by_id` if you have the `agent_id` instead of the name.

### Shared task list (per team)

```text
task_add({ title, description? })
task_list({ status?: "open" | "claimed" | "done" })
task_claim({ task_id })
task_complete({ task_id, result? })
```

## More

- Full tool reference and schema: launch the daemon and call `tools/list` on the MCP endpoint.
- Codex / opencode setup details: `docs/configs/`.
- Source: [github.com/jtianling/cross-agent-teams-mcp](https://github.com/jtianling/cross-agent-teams-mcp).
