# cross-agent-teams-mcp

[中文说明](./README.zh-CN.md)

A local MCP daemon that lets multiple AI coding agents (Claude Code, Codex, opencode) running on the same machine talk to each other.  Agents register, send 1-to-1 messages, broadcast to a team or role, and wake each other up — all over a single daemon, no external services.

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

### Other coding agents (opencode, cursor, ...)

Anything that is not Claude Code or Codex — opencode, cursor, an editor extension, your own harness — connects over plain Streamable HTTP and registers as `agent_type="custom"` (the agent figures this out for you).  There is no dedicated wake-up transport for these; cross-agent pokes are delivered by injecting text into the agent's tmux pane, so run the agent inside a tmux window and the daemon will resolve `pid → tty → pane` automatically when you register.

Per-tool config snippets live in [docs/configs/opencode.md](docs/configs/opencode.md) (and `docs/configs/` for the rest).

## 3. Use it from your agent

Once your agent is connected to the daemon, you don't have to memorize tool names.  Just talk to the agent in plain language and it will pick the right tool — the README below shows the *kinds of things you say*, not the underlying API.

> Note: always run these from inside the agent session.  Don't try to register or send messages with `curl` or any other external HTTP client — that opens a different MCP session and the messages won't reach you.

### Register the session

The first time an agent connects to xats it stays unregistered until you tell it to register.  Just say:

> Register me to xats as alice.

Or with an explicit team:

> Register me to xats as alice on team backend.

If you don't give a team, the agent uses your current working directory's basename — so you typically don't need to think about it.

### Talk to other agents

Address by name, by team, or by role:

> Send a message to bob: how is the migration going?
>
> Tell my team I'm starting the deploy.
>
> Send the frontend role a heads-up that the API will change.
>
> What's in my inbox?

The agent picks the right tool (`send_message`, `broadcast`, `broadcast_to_role`, `get_inbox`).  Outgoing messages also wake the recipient automatically — you don't need a separate poke.

### See who else is around

> Who else is registered on xats?
>
> List agents on team backend.

## More

- Full tool reference and schema: launch the daemon and call `tools/list` on the MCP endpoint.
- Per-agent config details: `docs/configs/`.
- Source: [github.com/jtianling/cross-agent-teams-mcp](https://github.com/jtianling/cross-agent-teams-mcp).
