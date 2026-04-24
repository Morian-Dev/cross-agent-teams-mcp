## Why

Codex clients currently cannot auto-bind their tmux pane during `register_agent`: the agent's tool shell runs under `codex app-server`, so `$PPID` points at the app-server (shared across sessions), not the actual `codex --remote` UI process in a tmux pane.  Global `detect_tmux_pane({agent:"codex"})` returns `ambiguous_match` whenever more than one codex UI is running — which is expected in this project's multi-agent workflow.  The user's target architecture (one app-server, many codex UIs sharing it) makes this worse: `cwd`, `ws_url`, `XATS_AGENT_ID` env are all non-unique or unreachable from the agent's tool shell.

The launcher, however, always knows the tmux pane it is starting codex in (`$TMUX_PANE`) and is free to generate a per-launch UUID.  If the launcher pre-registers `(pane, uuid)` with the daemon before spawning codex, the daemon has enough information to resolve ui_pid when the agent later calls `register_agent` — without the agent needing to know its own UUID or pane.

## What Changes

- Add a new MCP tool `pre_register_codex_pane(pane_id, xats_agent_id, ttl_seconds?)` that records a pending pre-registration keyed by tmux `pane_id`.  The record stores the UUID launcher will also pass as `-c xats.agent_id="<uuid>"` on the `codex --remote` command line, plus an expiry timestamp.
- Extend `register_agent` so that when `client="codex"`, no `ui_pid` / `tmux_pane_id` is supplied, and exactly one matching pending pre-reg exists (pane running a `codex --remote` process whose argv contains the recorded UUID), the daemon auto-resolves the UI pid from that pane and binds tmux identity through the standard `bind_runtime_identity` path.  The consumed pre-reg is deleted.
- Ship a thin CLI entry point (`xats-mcp pre-register-codex-pane`) so the `free-xats-codex` zsh launcher can invoke the new tool from shell without linking an MCP client.  Document an updated `free-xats-codex` function in `docs/` that generates the UUID, calls the CLI, then `exec`s codex with the matching `-c xats.agent_id` flag.
- Pending pre-regs expire after `ttl_seconds` (default 120s) or on first successful match.  The daemon garbage-collects expired rows at pre-reg write time and during register consumption.
- No changes to the existing `codex-appserver` delivery path: this proposal is only about runtime-identity / tmux binding.  The `thread_id` problem for the primary wake channel is out of scope.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `agent-registry`: new `pre_register_codex_pane` tool, new `register_agent` auto-resolution path for codex clients that consumes pending pre-regs, new persistence of pane-scoped pre-reg records with TTL expiry.

## Impact

- `src/mcp/tools.ts`: register new `pre_register_codex_pane` tool; extend `executeRegister` / `autoBindRuntimeIdentity` to consult the pending pre-reg table when `client="codex"` and no `ui_pid` was supplied.
- `src/mcp/` new service module (`pre-register-codex-pane.ts`) and repository wiring.
- `src/lib/` schema migration for a new `codex_pane_pre_registrations` table (or equivalent in-memory structure with file persistence, see design).
- `src/cli/` new subcommand `pre-register-codex-pane` that opens a short-lived stdio MCP client and calls the tool.
- `docs/`: updated `free-xats-codex` shell function; user-facing explanation of the new launcher contract.
- No changes to existing transports, delivery dispatch, opencode/claude-code registration paths.
