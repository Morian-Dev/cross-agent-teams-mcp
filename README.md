# cross-agent-teams-mcp

[中文说明](./README.zh-CN.md)

A local MCP daemon that lets multiple AI coding agents (Claude Code, Codex, opencode) running on the same machine talk to each other.  Agents register, send 1-to-1 messages, broadcast to a team or role, and wake each other up — all over a single daemon, no external services.

## Quick start

### Claude Code

```bash
# 1. Start the daemon (run once, keep it alive)
npx -y cross-agent-teams-mcp@latest daemon --port 9100 &

# 2. In your project, install the MCP config
npx mcpsmgr add jtianling/cross-agent-teams-mcp -a claude-code

# 3. Start Claude Code with the channel loader (manual permission prompt expected)
claude --dangerously-load-development-channels server:cross-agent-teams-channel
```

### Other agents (Codex, opencode, ...)

```bash
# 1. Start the daemon (run once, keep it alive)
npx -y cross-agent-teams-mcp@latest daemon --port 9100 &

# 2. In your project, install the MCP config (interactive picker)
npx mcpsmgr add jtianling/cross-agent-teams-mcp

# 3. Start your coding agent as usual
```

Note: only Claude Code gets push wake out of the box.  Codex needs the `--remote` + launcher setup (see section 2 below) for pokes; without it, it has a mailbox but no wake.  opencode / cursor / other agents only receive pokes when running inside a tmux pane.  If push wake isn't wired up, ask the agent to check its inbox manually ("check my xats inbox").

Then talk to your agent in plain language:

```
# In agent A:
Register me to xats as backend on team default.

# In agent B:
Register me to xats as frontend on team default.
Send backend a message: the API has changed.
```

That's it.  Sections below cover the details — daemon flags, manual MCP config, codex `--remote` setup, more usage patterns.

## 1. Start the daemon

Run this once on your machine and keep the process alive (dedicated terminal, `tmux`, `screen`, `launchd` — your call):

```bash
npx -y cross-agent-teams-mcp@latest daemon --port 9100
```

The daemon listens on `127.0.0.1:9100`.  MCP endpoint is `http://127.0.0.1:9100/mcp`, health endpoint is `http://127.0.0.1:9100/health`.

Common flags:

- `--port <n>` (default `9100`)
- `--host <addr>` (default `127.0.0.1`)
- `--device <label>` (default: hostname-derived label)
- `--token <t>` (Bearer auth)
- `--db <path>` (default `~/.cross-agent-teams-mcp/data.db`)
- `--pid-file <path>` (default `~/.cross-agent-teams-mcp/daemon.pid`)

### Cross-host (LAN) collaboration

To let agents on another trusted machine use this daemon, bind the daemon to a LAN address and set a shared bearer token:

```bash
npx -y cross-agent-teams-mcp@latest daemon \
  --host 192.168.1.10 \
  --port 9100 \
  --token "$XATS_TOKEN" \
  --device jt-laptop
```

Then configure the peer host's Claude Code channel proxy to connect back to that daemon:

```bash
npx -y -p cross-agent-teams-mcp@latest cross-agent-teams-channel \
  --daemon-url http://192.168.1.10:9100/mcp \
  --token "$XATS_TOKEN" \
  --device gx-laptop
```

Agents are namespaced by `(device, team, name)`.  A bare `send_message({to_agent_name:"creator"})` resolves on the caller's own device; use `creator:gx-laptop` to address a same-team agent on another device.  `list_agents` shows the `device` field so you can compose those addresses.

Security notes: non-loopback `--host` requires `--token`, and the token is shared by everyone who can use that daemon.  Treat LAN exposure as trusted-team only; there is no per-agent authorization, device whitelist, or TLS in this mode.

Upgrade note: the first startup after this version auto-migrates the storage schema from `(team, name)` identity to `(device, team, name)` identity and backfills existing rows with the daemon's local `--device` label.  Rolling back after registering multiple devices with the same `(team, name)` can violate the old uniqueness assumption.

## 2. Configure your agent's MCP client

### Recommended: `mcpsmgr` (shown in Quick start)

[`mcpsmgr`](https://www.npmjs.com/package/mcpsmgr) reads this repo's `mcpsmgr.json` and writes the right MCP entries into your agent's config in one shot — including the Claude Code stdio channel proxy entry, the Codex `experimental_use_rmcp_client` toggle, and the streamable-http MCP entry.

To override the daemon port:

```bash
npx mcpsmgr add jtianling/cross-agent-teams-mcp -a claude-code --port 9300
```

### Manual config

If you don't want `mcpsmgr` (private fork, custom token, custom stdio args, or you just prefer hand-edited config), the raw per-agent configs are below.

#### Claude Code (needs both entries — HTTP for tools, stdio for channel wake)

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

The `server:<name>` suffix MUST equal the MCP server key in `.mcp.json` (`cross-agent-teams-channel` above).  If your daemon uses `--token <t>`, add `"headers": { "Authorization": "Bearer <t>" }` to the HTTP entry, and add `--token <t>` to the channel proxy args.

#### Codex CLI

Codex talks to the daemon over Streamable HTTP.  Wake-ups go through Codex's own app-server WebSocket transport — there is no channel proxy involved.

##### Minimum config (mailbox only, no push wake)

`~/.codex/config.toml`:

```toml
experimental_use_rmcp_client = true

[mcp_servers.cross-agent-teams-mcp]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
```

`experimental_use_rmcp_client = true` MUST sit at the top level — without it, streamable-http MCP servers fail to load.

(With `--token <t>` on the daemon: add `[mcp_servers.cross-agent-teams-mcp.headers]` and `Authorization = "Bearer <t>"`.)

In this minimum mode, `send_message` to this Codex still drops a row in its mailbox, but you have to call `get_inbox` yourself to read it — no push wake.

##### Let other agents wake you (codex-appserver poke)

To let other agents **wake** this Codex thread (not just mail it), you need `codex-appserver` delivery.  The setup has one non-obvious gotcha worth calling out:

> **In `codex --remote` mode, MCP servers are loaded by the app-server, NOT by the TUI.**  The MCP entry above must therefore live in the `CODEX_HOME` that the **app-server** reads at startup — usually the global `~/.codex/config.toml`.  Setting `CODEX_HOME` on the TUI alone does nothing for MCP under `--remote`.

Start order:

```bash
# 1) Long-lived codex app-server somewhere (its CODEX_HOME decides the MCP set).
codex app-server --listen ws://127.0.0.1:8799

# 2) Codex TUI in a separate terminal, connected to the same app-server.
codex --remote ws://127.0.0.1:8799
```

If the app-server's `CODEX_HOME` doesn't have `cross-agent-teams-mcp` configured, the codex agent inside `--remote` won't see the MCP tools at all and `register_agent` will never fire.

##### Recommended: launcher with tmux pane auto-bind

For pokes to be injected directly into the running Codex thread (rather than landing as a tmux paste), the daemon needs to know which tmux pane the codex process lives in.  The launcher pre-claims a pane via the `pre-register-codex-pane` CLI before exec'ing codex.  Add to `~/.zshrc`:

```zsh
free-xats-codex() {
    local xats_agent_id codex_home search_dir
    xats_agent_id="$(uuidgen)"
    search_dir="$PWD"
    while [[ "$search_dir" != "/" ]]; do
        if [[ -f "$search_dir/.codex/config.toml" ]]; then
            codex_home="$search_dir/.codex"
            break
        fi
        search_dir="${search_dir:h}"
    done

    if [[ -n "$TMUX_PANE" ]]; then
        npx -y cross-agent-teams-mcp pre-register-codex-pane \
            --pane "$TMUX_PANE" \
            --agent-id "$xats_agent_id" \
            >/dev/null 2>&1 \
            || echo "[xats] pre-register failed (continuing without pane claim)" >&2
    fi

    if [[ -n "$codex_home" ]]; then
        CODEX_HOME="$codex_home" exec codex \
            --remote ws://127.0.0.1:8799 \
            -c xats.agent_id="\"$xats_agent_id\"" "$@"
    else
        exec codex \
            --remote ws://127.0.0.1:8799 \
            -c xats.agent_id="\"$xats_agent_id\"" "$@"
    fi
}
```

What the launcher does:

- Inside tmux (`$TMUX_PANE` set): pre-registers the pane → uuid mapping with the daemon (120s TTL).  When the codex agent later calls `register_agent({agent_type: "codex", thread_id: $CODEX_THREAD_ID, ...})`, the daemon resolves `tmux_pane_id` automatically by matching the pre-reg against the codex argv.
- `--remote ws://127.0.0.1:8799` connects to the long-lived app-server from step (1) above.
- `-c xats.agent_id="\"$uuid\""` exposes the uuid in codex's argv so the daemon can verify the pane.

More detail (auth headers, lower-level `register_agent` form): [docs/configs/codex-cli.md](docs/configs/codex-cli.md).

#### Other coding agents (opencode, cursor, ...)

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

### Cross-device communication

When an agent connects to a daemon running on **another machine** (the Cross-host (LAN) section above), it must self-declare a `device` label at registration:

> Register me to xats as alice, device gx-laptop.

That label becomes part of the agent's identity — `(device, team, name)` — so two physical machines can both have a `creator` in `team=default` without collision.  Once registered with a device, addressing across devices uses a `name:device` suffix:

> Send creator on jt-laptop a message: build is green.

This resolves to `creator:jt-laptop` and routes to that exact `(device=jt-laptop, team=…, name=creator)` row.  Bare `creator` resolves on the caller's own device.

Notes:

- The daemon's local label is set with its own `--device` flag (defaults to the daemon host's hostname normalized to lowercase + `-`).  Local-loopback agents auto-fill that label and don't need to specify `device` on register.
- A remote register call that omits `device` is rejected with `device_required_from_remote`; the channel proxy's startup hint surfaces the configured device value so the agent prompt includes it verbatim.
- `list_agents` returns a `device` field on every entry so you can see which devices contribute to your team and pick the right `name:device` target.
- The channel proxy's `--device` flag (`cross-agent-teams-channel --device gx-laptop ...`) sets the device label for the proxy row and is propagated into the registration hint surfaced to the agent.  Match it to whatever label you want your machine's agents to appear under.

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
