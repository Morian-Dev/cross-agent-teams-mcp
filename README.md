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

For multi-host / multi-device setups (LAN, tailscale, etc.), see [section 4](#4-cross-host--cross-device-collaboration) below.

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

When the daemon was started with `--token <t>`: `export XATS_TOKEN=<t>` in the shell that launches codex, then add `bearer_token_env_var = "XATS_TOKEN"` to the `[mcp_servers.cross-agent-teams-mcp]` block.  (Codex 0.130+ silently ignores the older `[mcp_servers.X.headers]` form — its accepted keys are `http_headers` and `bearer_token_env_var`, and `bearer_token_env_var` is preferred so the token never lands in a checked-in config.)

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
            -C "$PWD" \
            -c xats.agent_id="\"$xats_agent_id\"" "$@"
    else
        exec codex \
            --remote ws://127.0.0.1:8799 \
            -C "$PWD" \
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

## 4. Cross-host / cross-device collaboration

Most users only need the single-host setup above; the `device` axis is invisible in loopback-only setups and you can skip this entire section.  Read on only if you want agents on multiple physical machines (LAN, tailscale, etc.) to share one daemon.

The setup needs three coordinated changes — **daemon bind**, **peer `.mcp.json`**, and **agent registration**.  Agents are namespaced by `(device, team, name)`: a bare `send_message({to_agent_name:"creator"})` resolves on the caller's own device, while `creator:host-b` addresses a same-team agent on another device.

### 1. Daemon-side: bind beyond loopback

Stop the daemon and restart with a non-loopback `--host` and a `--token`.  The token is mandatory whenever `--host` is non-loopback — the daemon refuses to start otherwise (`token_required_for_non_loopback_bind`).  Optionally set `--device` for the daemon-host label (defaults to `os.hostname()` lowercased with `[^a-z0-9_-]` replaced by `-`):

```bash
npx -y cross-agent-teams-mcp@latest daemon \
  --host 0.0.0.0 \
  --port 9100 \
  --token "$XATS_TOKEN" \
  --device host-a
```

Use a specific LAN IP (e.g. `10.0.0.10`) or a tailscale CGNAT IP (`100.x.x.x`) instead of `0.0.0.0` if you want to restrict the listener.  macOS will prompt to allow node to accept network connections on the first non-loopback bind.

### 2. Peer-side: `.mcp.json` updates

Each remote teammate's Claude Code needs **two** changes from the default loopback config: the HTTP entry must carry an `Authorization: Bearer …` header, and the channel proxy must pass `--token` AND `--device`:

```json
{
  "mcpServers": {
    "cross-agent-teams": {
      "type": "http",
      "url": "http://10.0.0.10:9100/mcp",
      "headers": {
        "Authorization": "Bearer xats"
      }
    },
    "cross-agent-teams-channel": {
      "command": "npx",
      "args": [
        "-y", "-p", "cross-agent-teams-mcp@latest",
        "cross-agent-teams-channel",
        "--daemon-url", "http://10.0.0.10:9100/mcp",
        "--token", "xats",
        "--device", "host-b"
      ]
    }
  }
}
```

For Codex CLI, edit `~/.codex/config.toml`:

```toml
[mcp_servers.cross-agent-teams-mcp]
url = "http://10.0.0.10:9100/mcp"
bearer_token_env_var = "XATS_TOKEN"
```

…and `export XATS_TOKEN=xats` before launching codex.

The **daemon-side** `.mcp.json` (the machine running the daemon) needs the same `headers.Authorization` because the daemon now requires the token on every request, even loopback ones — once `--token` is set, no path through `/mcp` is unauthenticated.

### 3. Agent registration

Restart Claude Code (or codex) on the peer machine so the channel proxy spawns with the new `--device` argument.  The proxy's startup hint then embeds the device verbatim, and the user's reply contains it too:

> Register me to xats as alice, device host-b.

If a remote `register_agent` call omits `device`, the daemon rejects with `device_required_from_remote` — the agent must self-declare.  `device` becomes part of the identity tuple `(device, team, name)`, so two physical machines can each host a `creator` in `team=default` without collision.

### 4. Addressing across devices

Once everyone is registered, use the `name:device` suffix to address a same-team agent on another device:

> Send creator on host-a a message: build is green.

This resolves to `creator:host-a` and routes to that exact `(device=host-a, team=…, name=creator)` row.  A bare `creator` always resolves on the caller's own device.

Notes:

- `list_agents` returns a `device` field on every entry — use it to see which devices contribute to your team and to compose the right `name:device` target.
- `get_inbox` returns `from_name` and `from_device` on every message.  When replying via `send_message`, if `from_device !== <your device>` use `from_name:from_device`; otherwise the bare name is correct.  `send_message_by_id({to_agent_id: from_agent_id, ...})` is the device-agnostic safe fallback.
- Security caveat: the bearer token is shared across everyone who can reach the daemon.  Treat LAN exposure as a trusted-team boundary; there is no per-agent auth, device whitelist, or TLS in this mode.
- Upgrade note: the first startup after introducing the `device` axis auto-migrates the storage schema from `(team, name)` identity to `(device, team, name)` identity and backfills existing rows with the daemon's local `--device` label.  Rolling back after registering multiple devices with the same `(team, name)` can violate the old uniqueness assumption.

### 5. Codex-specific gotchas under cross-device setups

The `--token` + Codex `--remote` combination surfaces three caveats that don't show up in loopback-only single-device setups:

- **App-server env is frozen at launch.**  `codex app-server --listen ...` inherits its environment from the shell that started it.  If you set `bearer_token_env_var = "XATS_TOKEN"` and later `export XATS_TOKEN=…` in another shell, the running app-server still doesn't see it — Codex MCP startup fails with `Deserialize error: data did not match any variant of untagged enum JsonRpcMessage` (codex tries to parse the daemon's 401 body as a JSON-RPC frame).  Restart the app-server from a shell that already has `XATS_TOKEN` exported.

- **`--remote` hijacks the working directory.**  Under `codex --remote …` the session cwd is the **app-server's** cwd, not the TUI's — so a launcher invoked from any directory ends up wherever the app-server was started.  Pass `-C "$PWD"` to the `codex` command (already in the launcher above) to override per-session.

- **Project-level `.codex/config.toml` overlays the global one.**  A stale per-project block — especially in an iCloud / Dropbox-synced project directory shared between machines — can shadow your global auth setup and produce a failed MCP server name you don't recognize.  Symptom: codex reports a startup failure for a server that doesn't appear in `codex mcp list` (which only reflects the global config).  Audit with `find ~ -path '*/.codex/config.toml' -print` and remove or update stale entries.

## More

- Full tool reference and schema: launch the daemon and call `tools/list` on the MCP endpoint.
- Per-agent config details: `docs/configs/`.
- Source: [github.com/jtianling/cross-agent-teams-mcp](https://github.com/jtianling/cross-agent-teams-mcp).
