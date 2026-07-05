# README.agent.md — xats device setup guide (for code agents)

> Audience: a code agent configuring the xats (cross-agent-teams-mcp) launch
> environment on a new device.  Follow this document in order; when done, the
> device can launch codex / opencode / claude-code agents with xats
> communication wired up, using a single set of shell commands.

Target UX after setup:

1. Device-resident services are managed with `start-xats` / `stop-xats`
   (daemon + codex app-server);
2. Each project needs at most one
   `npx mcpsmgr add jtianling/cross-agent-teams-mcp -a <agent>` run
   (currently only opencode / claude-code need it; codex does not, see
   section 3);
3. Running `free-xats-codex` / `xats-codex` / `free-xats-opencode` /
   `xats-opencode` launches the corresponding agent with xats transport poke
   etc. working out of the box.
   `free-` prefix = yolo mode (skip approvals/sandbox), no prefix = normal
   approval mode.

## 0. Before you start: three things to align with the user

1. **daemon token**: once the daemon runs with `--token`, every agent-side
   config must carry the same token; any mismatch is a 401.  You do **not**
   need to ask the user for a token: the first `start-xats` run auto-generates
   one, format `<hostname>-<6 random digits>`, **unique per device — never
   reuse another device's value**.  It is printed for the user and persisted
   to `~/.config/xats/token`; every new shell exports it via zshrc.  Wherever
   this document says `<TOKEN>`, it means the current value of
   `$CROSS_AGENT_TEAMS_MCP_TOKEN`.  The daemon listens on `0.0.0.0`
   (required for cross-device teams), so a token is mandatory.
2. **device label**: one short, unique label per device (e.g. `jt`,
   `jtianling-mac-mini`), used as the `name:device` suffix for cross-device
   addressing.  Ask the user to pick one.
3. **consent to edit ~/.zshrc**: this repo never silently modifies the user's
   shell config.  Show the section 2.1 snippet to the user and write it only
   after approval.

## 1. Architecture in one minute (why these steps)

- **daemon** (port 9100): the hub for all agent communication; resident
  process, one per device.
- **codex**: the TUI connects with `--remote` to a resident codex app-server
  (port 8799).  Key constraint: **in `--remote` mode, MCP servers are loaded
  by the app-server's CODEX_HOME**, usually the global
  `~/.codex/config.toml`.  So codex's xats MCP config is **device-level**;
  a project-level `.codex/config.toml` does not affect MCP under `--remote`.
- **opencode**: every instance ships its own HTTP server.  The launcher
  allocates a random loopback port and exports `OPENCODE_XATS_BASE_URL`;
  the daemon push-wakes it through `prompt_async` — no tmux dependency.
  Its MCP config is **project-level** `opencode.json`, written by mcpsmgr.
- **claude-code**: MCP + channel server config is project-level `.mcp.json`,
  written by mcpsmgr; launch with `--dangerously-load-development-channels`
  to attach the channel.
- **pre-register-codex-pane**: before exec'ing codex, the launcher announces
  "pane X is about to run agent UUID Y" to the daemon, so a later
  `register_agent` from inside codex auto-binds the tmux pane — no manual
  `bind_runtime_identity` needed.

## 2. Device-level one-time setup

### 2.1 ~/.zshrc snippet

Check for old versions first: `grep -n 'xats' ~/.zshrc`.  If old definitions
of `free-xats-codex` / `free-xats-opencode` / `start-xats` / `XATS_TOKEN`
etc. exist, confirm with the user and **remove or comment out the old block**
before writing the snippet below (zsh lets later definitions win, but stale
aliases interfere with functions and stale variable names mislead debugging).

Append the whole block to `~/.zshrc` (replace `<DEVICE>`):

```zsh
# ===== xats (cross-agent-teams-mcp) =====
# Single token variable: referenced by both daemon --token and codex
# bearer_token_env_var.  Auto-generated and persisted by the first start-xats
# run; do not hand-write the value.
XATS_TOKEN_FILE="$HOME/.config/xats/token"
[[ -f "$XATS_TOKEN_FILE" ]] && export CROSS_AGENT_TEAMS_MCP_TOKEN="$(<"$XATS_TOKEN_FILE")"
XATS_DEVICE="<DEVICE>"

start-xats() {
    if [[ -z "$CROSS_AGENT_TEAMS_MCP_TOKEN" ]]; then
        mkdir -p "${XATS_TOKEN_FILE:h}"
        printf '%s-%06d' "$(hostname -s)" \
            "$(( $(od -An -N4 -tu4 /dev/urandom | tr -d ' ') % 1000000 ))" \
            > "$XATS_TOKEN_FILE"
        chmod 600 "$XATS_TOKEN_FILE"
        export CROSS_AGENT_TEAMS_MCP_TOKEN="$(<"$XATS_TOKEN_FILE")"
        echo "[xats] generated daemon token: $CROSS_AGENT_TEAMS_MCP_TOKEN"
        echo "[xats] saved to $XATS_TOKEN_FILE (remove the file to regenerate)"
    fi

    npx -y cross-agent-teams-mcp@latest daemon \
      --host 0.0.0.0 \
      --port 9100 \
      --token "$CROSS_AGENT_TEAMS_MCP_TOKEN" \
      --device "$XATS_DEVICE" &

    codex app-server --listen ws://127.0.0.1:8799 &
}

stop-xats() {
    local label port found=0
    local -a pids
    for spec in "xats daemon:9100" "codex app-server:8799"; do
        label="${spec%%:*}"; port="${spec##*:}"
        pids=("${(@f)$(lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null)}")
        if [[ -n "${pids[1]}" ]]; then
            echo "[xats] stopping ${label} (port ${port}, pid ${pids[*]})"
            kill "${pids[@]}" 2>/dev/null
            found=1
        else
            echo "[xats] ${label} not running (port ${port})"
        fi
    done
    (( found )) || { echo "[xats] nothing to stop"; return; }
    sleep 1
    for port in 9100 8799; do
        pids=("${(@f)$(lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null)}")
        if [[ -n "${pids[1]}" ]]; then
            echo "[xats] force-killing survivors on port ${port} (pid ${pids[*]})"
            kill -KILL "${pids[@]}" 2>/dev/null
        fi
    done
}

_xats-codex() {
    local xats_agent_id ws_url
    xats_agent_id="$(uuidgen)"
    ws_url="ws://127.0.0.1:8799"

    if ! nc -z 127.0.0.1 8799 >/dev/null 2>&1; then
        echo "[xats] codex app-server not running, starting it" >&2
        codex app-server --listen "$ws_url" >/dev/null 2>&1 &!
        local _i
        for _i in {1..20}; do
            nc -z 127.0.0.1 8799 >/dev/null 2>&1 && break
            sleep 0.5
        done
        if ! nc -z 127.0.0.1 8799 >/dev/null 2>&1; then
            echo "[xats] failed to start codex app-server on $ws_url" >&2
            return 1
        fi
    fi

    if [[ -n "$TMUX_PANE" ]]; then
        npx -y cross-agent-teams-mcp pre-register-codex-pane \
            --pane "$TMUX_PANE" \
            --agent-id "$xats_agent_id" \
            >/dev/null 2>&1 \
            || echo "[xats] pre-register failed (continuing without pane claim)" >&2
    fi

    command codex "$@" \
        --remote "$ws_url" \
        -C "$PWD" \
        -c xats.agent_id="\"$xats_agent_id\""
}

free-xats-codex() { _xats-codex --dangerously-bypass-approvals-and-sandbox "$@"; }
xats-codex()      { _xats-codex "$@"; }

_xats-opencode() {
    local port
    port="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
    OPENCODE_XATS_BASE_URL="http://127.0.0.1:${port}" \
        exec opencode --port "${port}" --hostname 127.0.0.1 "$@"
}

free-xats-opencode() { _xats-opencode --auto "$@"; }
xats-opencode()      { _xats-opencode "$@"; }

alias free-xats-claude="claude --dangerously-skip-permissions --dangerously-load-development-channels server:cross-agent-teams-channel"
alias xats-claude="claude --dangerously-load-development-channels server:cross-agent-teams-channel"
# ===== end xats =====
```

Key points (understand before changing anything):

- `-C "$PWD"` in `_xats-codex` must stay: `codex --remote` defaults to the
  app-server's cwd; without it the session lands in whatever directory the
  app-server was started from.
- `-c xats.agent_id="\"$uuid\""` puts the uuid into codex's argv; the daemon
  verifies the pre-registered pane against it.  Do not remove.
- `_xats-opencode` uses `exec`: the shell/pane ends together with opencode.
  This is intended behavior (the launcher is the session).
- pre-register failing, or not being inside tmux, never blocks the launch —
  it only degrades to "no automatic pane binding".
- `_xats-codex` auto-starts the app-server (disowned via `&!`) when it is not
  running.  The current shell has the token env exported already, so there is
  no env-freeze problem; it errors out only if the startup itself fails.

### 2.2 Global ~/.codex/config.toml

Recommended: use mcpsmgr (>= 0.4.8, see section 7).  Mind the three-step
order:

```bash
source ~/.zshrc && start-xats   # first run: generates the token into env (see 2.3)
npx -y mcpsmgr@latest add jtianling/cross-agent-teams-mcp -a codex --global -y
stop-xats && start-xats         # restart so the app-server loads the new MCP config
```

What it writes is equivalent to the manual config below.  If mcpsmgr is not
usable, or you need to merge by hand, append yourself (if the file already
has `experimental_use_rmcp_client` or a same-named server block, merge rather
than duplicating):

```toml
experimental_use_rmcp_client = true

[mcp_servers.cross-agent-teams-mcp]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
bearer_token_env_var = "CROSS_AGENT_TEAMS_MCP_TOKEN"
```

- `experimental_use_rmcp_client = true` must be **top-level**; without it,
  codex does not load streamable-http MCP servers at all.
- Do not use the legacy `[mcp_servers.X.headers]` form: codex 0.130+ silently
  ignores it and the daemon returns 401.  The env var name referenced by
  `bearer_token_env_var` must match the one exported in section 2.1.
- Version requirement: codex 0.124.0+ (exports `CODEX_THREAD_ID` to MCP tool
  processes, required for registration).

### 2.3 Start resident services and verify

```bash
source ~/.zshrc
start-xats
# wait a few seconds, then verify:
nc -z 127.0.0.1 9100 && echo daemon-ok
nc -z 127.0.0.1 8799 && echo appserver-ok
```

The first run prints the auto-generated token — **relay it to the user**.

Note: an app-server's environment is frozen at launch time.  Token generation
and export happen inside `start-xats` before either service starts, so the
normal flow is safe.  Rotating the token later (delete the token file)
requires `stop-xats` then `start-xats`, and **already-open shells** need a
fresh `source ~/.zshrc` to pick up the new env.

## 3. Per-project setup (once per project)

### 3.1 opencode

In the project root:

```bash
npx -y mcpsmgr@latest add jtianling/cross-agent-teams-mcp -a opencode -y
```

- With mcpsmgr >= 0.4.8, `-y` is non-interactive: the token is read from the
  env var `CROSS_AGENT_TEAMS_MCP_TOKEN` (present under this document's token
  policy; `start-xats` must have run at least once), or pass it explicitly
  with `--var CROSS_AGENT_TEAMS_MCP_TOKEN=<TOKEN>`.
- Without `-y`, the interactive prompt asks for
  `CROSS_AGENT_TEAMS_MCP_TOKEN` (masked input); pressing enter = skip = 401
  later.  To view the token: `echo $CROSS_AGENT_TEAMS_MCP_TOKEN` (or
  `cat ~/.config/xats/token`).
- **Old versions (<= 0.4.7) silently skip the token under `-y` — do not use
  them.**
- Manual fallback — edit the generated `opencode.json`:

```json
{
  "mcp": {
    "cross-agent-teams": {
      "type": "remote",
      "url": "http://127.0.0.1:9100/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" },
      "enabled": true
    }
  }
}
```

- `opencode.json` contains the plaintext token; make sure it is in
  `.gitignore` or the user accepts committing it.

### 3.2 codex — no per-project step

codex's xats MCP config is device-level (section 2.2); do **not** run mcpsmgr
per project for it.  Note: old mcpsmgr (<= 0.4.7) without `--global` writes a
project-level `.codex/config.toml` which `--remote` mode ignores for MCP —
useless.  Use the `--global` form from section 2.2 (device-level, once).

### 3.3 claude-code

In the project root:

```bash
npx -y mcpsmgr@latest add jtianling/cross-agent-teams-mcp -a claude-code
```

Writes two servers into the project `.mcp.json`: `cross-agent-teams` (http
tool surface) and `cross-agent-teams-channel` (stdio channel).  Launch with
`xats-claude` / `free-xats-claude` from section 2.1 (the `server:` suffix
must equal the channel server key).

## 4. Daily launch and agent-side registration

| Command | Effect |
| --- | --- |
| `free-xats-codex` | yolo codex, connects to app-server, tmux pane pre-registered |
| `xats-codex` | same, normal approval mode |
| `free-xats-opencode` | yolo opencode, random port + push wake |
| `xats-opencode` | same, normal approval mode |
| `free-xats-claude` / `xats-claude` | claude-code with the xats channel attached |

Extra arguments pass through, e.g. `xats-opencode --model glm-5.2`.

After launch, the agent session registers itself via `register_agent`; key
parameters per agent type:

- **codex**: `agent_type="codex"`, `thread_id=$CODEX_THREAD_ID` (required),
  **do not pass `ui_pid`** (it disables the pre-register pane auto-bind
  path).
- **opencode**: `agent_type="opencode"`,
  `base_url=$OPENCODE_XATS_BASE_URL`, omit `session_id` (the daemon
  auto-resolves it).
- **claude-code**: `agent_type="claude-code"`, `ui_pid=$PPID`.
- Common: when no explicit `team`, pass `project_dir=$PWD`; the daemon
  derives the team from the directory basename.

## 5. Verification checklist

1. `nc -z 127.0.0.1 9100` and `nc -z 127.0.0.1 8799` both succeed.
2. Launch `free-xats-codex` inside tmux; `register_agent` from within the
   session succeeds and the response carries **no `hint`** (a hint means pane
   auto-binding did not converge).
3. Launch `free-xats-opencode`; inside the session
   `printenv OPENCODE_XATS_BASE_URL` is non-empty and `register_agent`
   returns an `agent_id`.
4. From another registered agent, `send_message` to the new agent returns
   `poked: true`, and the new agent wakes up and reads it via `get_inbox`.

## 6. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `[xats] failed to start codex app-server` | codex CLI not installed / not on PATH, or port 8799 taken.  Run `codex app-server --listen ws://127.0.0.1:8799` manually to see the raw error |
| `Deserialize error: data did not match any variant of untagged enum JsonRpcMessage` | Actually a daemon 401: the app-server cannot see the token env.  Restart from a shell that has it exported (`stop-xats` + `start-xats`) |
| xats MCP tools invisible inside codex | MCP config is not in the CODEX_HOME the app-server reads (global `~/.codex/config.toml`), or top-level `experimental_use_rmcp_client = true` is missing |
| 401 despite a configured token | Legacy `[mcp_servers.X.headers]` form (silently ignored on 0.130+); or a stale project-level `.codex/config.toml` overriding global auth.  Audit: `find ~ -path '*/.codex/config.toml' -print` |
| codex session lands in the wrong directory | Launcher lost `-C "$PWD"` |
| `register_agent` response carries `hint` | Not inside tmux, or pre-register failed/expired (120s TTL).  Still functional, just no pane auto-bind; call `bind_runtime_identity` to bind manually if needed |
| opencode gets no push wake | Not launched via the launcher (missing `OPENCODE_XATS_BASE_URL`), or `base_url` not passed at registration |
| All tools return `unknown_session` / `unknown_agent` after a daemon restart | Reconnect the MCP server, then `reconnect(ui_pid)` or `register_agent` to recover identity |

## 7. mcpsmgr version requirement

The mcpsmgr steps in this document require **mcpsmgr >= 0.4.8**
(`npx -y mcpsmgr@latest` satisfies this).  Key differences vs older versions
(<= 0.4.7):

1. `add -a codex` automatically ensures top-level
   `experimental_use_rmcp_client = true` in the target config.toml (recent
   codex defaults to the rmcp client; the key is a compatibility write for
   older codex and is left untouched if present).
2. The codex token is written as
   `bearer_token_env_var = "CROSS_AGENT_TEAMS_MCP_TOKEN"` (name taken from
   the xats manifest `envVars[].name`), never as a plaintext Authorization
   header; when the token is absent, empty `http_headers` / `headers` blocks
   are omitted entirely (opencode still gets a plaintext Bearer when a token
   exists — its config format has no env reference mechanism).
3. `--global` (codex only): writes the global `~/.codex/config.toml`; this is
   the one-shot entry used in section 2.2.  Other agents reject `--global`.
4. Non-interactive token: repeatable `--var NAME=VALUE`; source priority is
   `--var` > `process.env` > interactive prompt; with a value in env, `-y` no
   longer silently skips it.

Old versions have none of the above (project-level codex config without the
rmcp toggle, plaintext / silently-skipped tokens) — do not run this document's
flow with them.

## 8. Hand-off: what to tell the user when you are done

After the section 5 checklist passes, print a short hand-off message to the
user.  It must contain:

1. **The commands now available**:
   - `start-xats` / `stop-xats` — manage the resident daemon + codex
     app-server;
   - `free-xats-codex` / `xats-codex` — launch codex (yolo / normal);
   - `free-xats-opencode` / `xats-opencode` — launch opencode (yolo /
     normal);
   - `free-xats-claude` / `xats-claude` — launch Claude Code with the xats
     channel.
2. **The daemon token value** and where it lives (`~/.config/xats/token`).
3. **The `source ~/.zshrc` reminder**: shells opened before this setup —
   including the very terminal the user is sitting in — do not have the new
   functions and env yet.  Run `source ~/.zshrc` there once, or open a new
   terminal.
4. **The per-project reminder**: every new project needs the one-liner from
   section 3 for opencode (`-a opencode -y`) / claude-code
   (`-a claude-code`); codex needs nothing per project.
