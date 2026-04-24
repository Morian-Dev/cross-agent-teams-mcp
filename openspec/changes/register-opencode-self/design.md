## Context

opencode is the only first-class xats client without launcher auto-bind.  Today `delivery.kind=none` / `opencode_base_url=NULL` / `opencode_session_id=NULL` is the default state for opencode agents, forcing all pokes onto the tmux fallback.  The HTTP `opencode-server` transport (see `src/mcp/opencode-transport.ts` and the `opencode-server-transport` capability spec) is functionally complete but unreachable from a normal opencode launch because nothing wires the two metadata fields for the running session.

For comparison:
- **claude-code** auto-binds via the `ui_pid` → `__channel_proxy__` match in `register_claude_self`.
- **codex** auto-binds via the `pre_register_codex_pane` + `register_codex_self` handshake driven by the launcher.
- **opencode** has `bind_opencode_session` but it is manual, two-step, and nobody calls it automatically.

This change introduces the symmetric launcher-driven handshake for opencode.

## Goals / Non-Goals

**Goals:**
- Make `opencode_base_url` and `opencode_session_id` populated automatically for an opencode process launched through the xats opencode launcher, so routine pokes select the HTTP transport instead of falling back to tmux.
- Mirror the codex pattern: pre-reg row keyed by tmux pane id with TTL, consumed by the register self-call when the caller process's pane matches.
- Keep the existing manual paths (`bind_opencode_session`, `register_agent({client:'opencode', base_url, session_id})`) working without behavior change, so existing callers are unaffected.
- Provide a launcher shell script the user can hook into `~/.zshrc` (e.g., as an `opencode` alias) so "launch opencode" in any terminal goes through the handshake automatically.

**Non-Goals:**
- No support for non-loopback opencode servers; the existing loopback-only constraint stays.
- No changes to the `opencode-server` HTTP transport itself; dispatch code reads the same two columns as today.
- No automatic lifecycle management of opencode sessions (server-side session garbage collection is out of scope; sessions live as long as opencode's server decides).
- No attempt to retrofit opencode processes already running at the time of daemon upgrade — only new launches benefit.

## Decisions

### D1. Separate pre-reg table instead of overloading the codex one

Current `codex_pane_pre_registrations` has columns `(pane_id, xats_agent_id, expires_at)`.  Opencode pre-reg needs `(pane_id, base_url, session_id, expires_at)` — the `xats_agent_id` column is not meaningful for opencode (opencode uses session id as its identifier, not a xats-minted UUID baked into argv).

**Decision**: create a new table `opencode_pane_pre_registrations (pane_id PRIMARY KEY, base_url TEXT NOT NULL, session_id TEXT NOT NULL, expires_at TEXT NOT NULL)` in `src/storage/schema.ts`.

**Alternative considered**: generalize to a single `pane_pre_registrations` table with a `kind` column and JSON `payload`.  Rejected because it weakens schema-level validation and makes migration noisier for a one-time shape difference — codex is unlikely to grow new pre-reg fields either.

### D2. Pre-reg lookup on `register_opencode_self` uses pid → tty → pane

`register_opencode_self` accepts no `pane_id` argument (following the codex pattern where the CLI does not know its own pane id).  The daemon resolves the caller's tmux pane from the MCP session's runtime context using the existing `pid → tty → pane` helper already consumed by codex pre-reg.

**Decision**: reuse `resolveCallerPane` (or equivalent) from the codex pre-reg path.  If no pane is resolved, or no matching live pre-reg row exists, the auto-bind silently no-ops (best-effort, leaves `opencode_base_url` / `opencode_session_id` NULL, same as codex).

**Alternative considered**: accept `base_url` and `session_id` directly on `register_opencode_self`.  Rejected: it duplicates `bind_opencode_session`, and the whole point of this change is to remove the manual passing.

### D3. Launcher script reads opencode server health, creates session, pre-regs, then execs opencode

The launcher (`launch-opencode.sh` at repo root, plus a helper subcommand in `src/cli.ts`) does:
1. `curl -fsS "${OPENCODE_BASE_URL:-http://127.0.0.1:4096}/global/health"` — if unhealthy, exits with a clear error; it does not try to start opencode serve (that is `start-server.sh`'s job).
2. `curl -fsS -X POST "${OPENCODE_BASE_URL}/session"` (or whichever endpoint opencode 1.14.19 exposes — validated against the running server) to create a new session; captures the returned `session_id`.
3. Reads the current tmux pane id from `$TMUX_PANE` (set by tmux for any process running inside a pane).  If empty, the launcher errors out and tells the user to run inside tmux.
4. Calls `cross-agent-teams-mcp pre-register-opencode-pane --pane "%X" --base-url "<url>" --session-id "ses_xxx"` to install the pre-reg row.
5. Execs `opencode` with whatever argv attaches the CLI to the just-created server session.  The exact argv shape is the one open question (see O1).  If no attach mode is found, the launcher falls back to execing plain `opencode` and prints a warning that the HTTP transport will be unreachable until opencode supports attach.

**Decision**: script is the wrapper; pre-reg CLI subcommand talks HTTP to the daemon MCP, matching `pre-register-codex-pane`.  Keep the launcher minimal — it is the single point that can break when opencode versions differ.

**Alternative considered**: embed launcher logic as a node script.  Rejected: bash matches the `start-server.sh` / `stop-server.sh` style and has fewer moving parts.

### D4. Strict zod schema on `register_opencode_self`

Following `register_codex_self`, the schema rejects unknown keys including `ui_pid`, `channel_session_id`, `delivery`, `base_url`, `session_id`, `thread_id`, `claude_ui_pid`.  This forces the auto-bind path and prevents callers from regressing to the manual form by accident.

**Decision**: accept only `name`, `team`, `role`, `project_dir`, `model`.  Default model falls back to an opencode-specific string (e.g., `opencode`).

### D5. TTL and expiration match codex

Pre-reg TTL defaults to 120s, capped at 600s, matches `pre_register_codex_pane`.  Expired rows are removed opportunistically on every `pre_register_opencode_pane` write and on every opencode-side register consumption attempt.

**Decision**: literal reuse of the codex TTL policy so the two pre-reg systems behave the same at runtime.

### D6. Consumption semantics: single-use but survives race

On successful auto-bind the daemon deletes the consumed pre-reg row in the same transaction as the agent-row update, matching codex consume semantics.  A follow-up `register_opencode_self` call on the same pane without a new pre-reg row cycles back to NULL metadata (no stale reuse).

### D7. `register_agent({client:'opencode'})` also benefits

When a caller goes through the unified `register_agent` path with `client='opencode'` and without `base_url` / `session_id`, the same pre-reg consumption fires.  This preserves backwards compatibility while making the unified entry point competitive with the new self-register tool.

Explicit `base_url` / `session_id` in `register_agent` continues to take precedence (the existing `bind_opencode_session` call inside `executeRegister` still runs) and skips the pre-reg lookup.

## Risks / Trade-offs

- **[Risk]** opencode 1.14.19 has no client-mode "attach to existing session" argv.  → Mitigation: the daemon-side pre-reg + auto-bind is useful even so (opencode HTTP poke can still target the server session; whether the user's interactive opencode CLI sees the prompt is a separate question), and the README will document the limitation.  If needed we revisit upstream opencode or a thin adapter process.
- **[Risk]** tmux `$TMUX_PANE` missing (user launches outside tmux).  → Mitigation: launcher exits with a clear error and a one-line "wrap your opencode inside tmux" hint.  Hard-requiring tmux is consistent with the current codex handshake.
- **[Risk]** opencode server session creation endpoint differs across versions.  → Mitigation: the launcher script reads `OPENCODE_SESSION_CREATE_PATH` env with a default that matches 1.14.19; future versions override via env.
- **[Trade-off]** A new sqlite table for what is effectively a one-line schema difference.  → Accepted for schema-level validation clarity (D1 alternative).
- **[Trade-off]** Launcher is bash, inheriting bash quoting / portability pitfalls.  → Accepted because it matches `start-server.sh`; if it grows we move to a node entry point.

## Migration Plan

1. Ship daemon changes (schema migration, two new tools, updated `register_agent` path, CLI subcommand).  Existing agents and `bind_opencode_session` callers are unaffected.
2. Ship launcher script + README rewrite.  Users opt in by aliasing `opencode` to the launcher in `~/.zshrc`.  Unchanged users keep the tmux fallback.
3. Deprecate the manual "start opencode serve + bind_opencode_session" recipe in a future change once the launcher is battle-tested.  Not in scope here.
4. Rollback: revert the change; the new table becomes dead weight but is harmless.  No data migration is needed because existing opencode rows' `opencode_base_url` / `opencode_session_id` remain meaningful.

## Open Questions

- **O1.** What argv does opencode 1.14.19 accept to attach its TUI to an existing server session?  Candidates to probe during implementation: `opencode --server URL`, `opencode --session ID`, environment variables like `OPENCODE_SERVER_URL` + `OPENCODE_SESSION_ID`.  If none of these work, the launcher delivers value on the daemon side only, and a follow-up spec item addresses upstream opencode.
- **O2.** Should `register_opencode_self` also persist `runtime_ui_pid` the way `register_claude_self` does for reactive rebinding?  Not obviously needed because opencode's reconnect story is different, but worth confirming when wiring `executeRegister`.
- **O3.** Does the existing `bind_opencode_session` loopback-only check cover pre-reg too?  The answer is yes — the HTTP dispatch still validates `opencode_base_url` at transport time (`src/mcp/transport-dispatch.ts`) — but the pre-reg CLI should also reject non-loopback `--base-url` at the CLI boundary to fail fast.
