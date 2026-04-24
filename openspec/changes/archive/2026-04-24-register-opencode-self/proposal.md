## Why

opencode clients are the only first-class runtime in xats that still has no launcher-side auto-bind path to its native poke transport.  Claude Code auto-binds `claude-channel` via the `ui_pid` + proxy match, and codex auto-binds `codex-appserver` via `pre_register_codex_pane` + `register_codex_self`.  opencode, by contrast, requires the user to manually start `opencode serve`, manually obtain a `session_id`, and manually call `bind_opencode_session` — none of this is wired into the launcher.

Empirically, a standalone `opencode` CLI started outside this handshake ends up with `delivery.kind=none` / `opencode_base_url=NULL` / `opencode_session_id=NULL`, so every incoming poke falls back to tmux keystrokes.  The HTTP `opencode-server` transport exists end-to-end (server, transport code, bind tool, E2E test) but is unreachable in normal daily use.  Bringing opencode in line with the other two runtimes eliminates the tmux dependency, reduces noise from keystroke injection, and makes the three-client matrix symmetric.

## What Changes

- Add MCP tool `pre_register_opencode_pane` that the opencode launcher calls before exec'ing the opencode CLI.  Stores `(pane_id → { base_url, session_id, xats_agent_id?, expires_at })` as a pending pre-reg row, matching the codex `pre_register_codex_pane` schema + TTL semantics.
- Add MCP tool `register_opencode_self` that the opencode process calls from its MCP session.  Mirrors `register_codex_self` shape: `name`, optional `team` / `role` / `project_dir` / `model`; strict schema rejects `ui_pid`, `channel_session_id`, `delivery`, `base_url`, `session_id`, `thread_id`, `claude_ui_pid`.  On success the daemon sets `client='opencode'` and runs the auto-bind path described below.
- Add auto-bind behavior: when `register_opencode_self` runs, the daemon resolves the caller's tmux pane via the existing `pid → tty → pane` mapping, looks up a live pre-reg row for that pane, and populates `opencode_base_url` + `opencode_session_id` from the pre-reg.  Expired or missing rows leave those fields `NULL` without failing the call (best-effort, consistent with codex).
- Extend the `register_agent({client:'opencode'})` path to consult the same pre-reg rows when `base_url` / `session_id` are omitted, so a caller that goes through the unified entry point still benefits from launcher pre-reg (analogous to the existing claude-code / codex behavior).
- Add an opencode launcher shell script (e.g., `launch-opencode.sh` or `scripts/launch-opencode.mjs`) that:
  1. Verifies the shared opencode server (`http://127.0.0.1:4096` by default) is healthy.
  2. Creates a new session on that server via its HTTP API and captures the returned `session_id`.
  3. Detects the current tmux pane id.
  4. Invokes `cross-agent-teams-mcp pre-register-opencode-pane --pane %X --base-url <url> --session-id <id>` (new CLI subcommand) so the pre-reg row is installed before opencode starts.
  5. Execs the opencode CLI with whatever client-mode arguments it accepts to attach to the just-created server session (concrete argv shape to be confirmed in `design.md` against opencode 1.14.19).
- Add the corresponding CLI subcommand `pre-register-opencode-pane` to `src/cli.ts`, matching the existing `pre-register-codex-pane` CLI.
- Update `src/mcp/tools.ts` descriptions so `register_agent` guides opencode callers toward `register_opencode_self`, and so `register_opencode_self` lists the launcher pre-reg as the expected activation path.
- Update README "Opencode Delivery" section to document the launcher-driven flow as the first-class path, demoting the manual `opencode serve` + `bind_opencode_session` recipe to a fallback for custom setups.

**Explicit assumption**: this change depends on opencode 1.14.19's CLI supporting some form of "attach to an existing server session" mode.  If the available opencode build does not support that mode, `design.md` must surface the gap and reduce scope (e.g., ship only the daemon-side plumbing and document the upstream blocker), or select a different wiring such as pure `OPENCODE_SESSION_ID` env-passing.  This assumption is validated during design, not during implementation.

## Capabilities

### New Capabilities

<!-- No new capability specs; all behavior extends existing `agent-registry` and `opencode-server-transport`. -->

### Modified Capabilities
- `agent-registry`: adds requirements for `pre_register_opencode_pane` (new tool), `register_opencode_self` (new tool with strict schema), auto-bind of `opencode_base_url` + `opencode_session_id` via pane match, parallel auto-bind on `register_agent({client:'opencode'})` when opencode metadata is omitted, and updates the existing "columns are written by `bind_opencode_session`, NOT by `register_agent`" requirement to reflect the new writers (`register_opencode_self` and the pre-reg path).  No changes needed to `opencode-server-transport` — the HTTP dispatch reads the same two columns regardless of which path populated them.

## Impact

- **New code**:
  - `src/mcp/pre-register-opencode-pane.ts` (service), registration in `src/mcp/tools.ts`.
  - `src/mcp/register-opencode-self.ts` (service), registration in `src/mcp/tools.ts`.
  - Pane-pre-reg integration inside the opencode branch of `executeRegister` in `src/mcp/tools.ts`.
  - `pre-register-opencode-pane` subcommand in `src/cli.ts`.
  - Launcher script at repo root (`launch-opencode.sh`) or `scripts/`.
- **DB schema**: no new columns; reuse existing `opencode_base_url` / `opencode_session_id` and the generic pre-reg table (or add a parallel `opencode_pane_prereg` table if the codex pre-reg table is not reusable — decided in `design.md`).
- **Tests**: new unit tests for the two services + dispatch integration tests covering the pre-reg → register → poke path.
- **Docs**: README "Opencode Delivery" rewritten; top-level MCP server instructions updated to mention `register_opencode_self` alongside the existing claude/codex hints.
- **No breaking changes**: existing `bind_opencode_session` and explicit `register_agent({client:'opencode', base_url, session_id})` paths remain supported and behave identically.
- **External dependency**: a supported opencode CLI client-mode (session attach) is required to make the end-to-end flow deliver pokes into the user's interactive opencode session.  If unavailable, only the daemon-side half ships and the launcher step is documented as "not yet activatable on opencode 1.14.19".
