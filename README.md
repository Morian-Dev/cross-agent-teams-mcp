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

Codex talks to the daemon directly over Streamable HTTP — no channel proxy needed; wake-ups go through Codex's own app-server transport.  See [docs/configs/codex-cli.md](docs/configs/codex-cli.md) for the config snippet.

### opencode

opencode connects directly over Streamable HTTP for tools.  It has no dedicated wake-up transport in this daemon (the previous `opencode-server` transport was removed); cross-agent pokes are delivered to opencode by injecting text into its tmux pane.  Run opencode inside a tmux window and the daemon will resolve `pid → tty → pane` automatically when you register.  See [docs/configs/opencode.md](docs/configs/opencode.md).

## 3. Register and communicate from inside the agent

Once your agent's MCP client is connected, run the registration helpers from inside the agent session — never from `curl` or another external HTTP client (that creates a different MCP session and breaks delivery).

### Register

Claude Code:

```text
register_claude_self({
  name: "<agent-name>",
  ui_pid: <Claude Code CLI pid; in a Bash tool call this is $PPID>,
  project_dir: "<your project's absolute path>"
})
```

Codex (when `CODEX_THREAD_ID` is exported by the harness):

```text
register_codex_self({
  name: "<agent-name>",
  thread_id: "<value of $CODEX_THREAD_ID>",
  project_dir: "<your project's absolute path>"
})
```

Unified entry point (any client):

```text
register_agent({
  client: "claude-code" | "codex" | "opencode" | "custom",
  name: "<agent-name>",
  model: "<model-name>",
  project_dir: "<your project's absolute path>",
  ui_pid: <runtime pid>          // optional but strongly recommended for non-codex
})
```

`team` defaults to the basename of `project_dir`; pass it explicitly only when you want a different team.  On success Claude Code registrations include `channel_session_id` in the response — that means wake delivery is wired up automatically.

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
