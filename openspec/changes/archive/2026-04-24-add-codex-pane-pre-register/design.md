## Context

Codex's tool shell runs under `codex app-server`, which is architecturally separate from the `codex --remote` UI process living in a tmux pane.  `$PPID` from the agent therefore resolves to the app-server (shared across sessions), and no environment variable the launcher sets reaches the tool shell.  Global `detect_tmux_pane({agent:"codex"})` cannot disambiguate between multiple codex panes, and in the target single-app-server multi-UI setup `cwd` and `ws_url` also collide.  The current session `new-gpt` had to resort to manual `ps` scanning + a `ui_pid` retry, which users should not be expected to do.

The one asymmetric piece of information is that the **launcher knows the tmux pane it's starting codex in** (`$TMUX_PANE`) and can generate a per-launch UUID.  If the launcher is allowed to seed that `(pane, uuid)` pair into the daemon before codex starts, the daemon can resolve the correct UI pid when the agent calls `register_agent`.

## Goals / Non-Goals

**Goals:**
- Eliminate manual `ui_pid` discovery for codex agents in the common case (launcher in tmux, user runs codex via the updated `free-xats-codex` function).
- Preserve existing `register_agent` behavior in every scenario that doesn't use pre-reg (no regressions for claude-code, opencode, codex-without-launcher, explicit `ui_pid` callers).
- Handle multi-codex-same-cwd correctly by keying on tmux `pane_id`, which is structurally unique.
- Keep the daemon-side failure modes benign: pre-reg lookup errors never corrupt `register_agent` success.

**Non-Goals:**
- Auto-resolving `thread_id` for the primary `codex-appserver` wake channel.  That still requires either explicit thread_id at register or a codex upstream change; this proposal is strictly about tmux / runtime identity.
- Supporting non-tmux launchers.  If `$TMUX_PANE` is empty the launcher SHALL NOT pre-register; registration falls back to the existing no-pane path.
- Cross-process locking for concurrent launches against the exact same pane; the "last write wins" semantics in Requirement 2 are sufficient because a single pane can only host one codex UI at a time.
- Persisting pre-reg records across daemon restarts.  Pre-regs are short-lived (TTL ≤ 600s); the sqlite row being transient is acceptable.

## Decisions

### D1: Persistent storage is a dedicated sqlite table, not an in-memory map

**Choice**: Add a new table `codex_pane_pre_registrations (pane_id TEXT PRIMARY KEY, xats_agent_id TEXT NOT NULL, expires_at TEXT NOT NULL)` via the existing `applySchema` migration pattern in `src/storage/schema.ts`.

**Rationale**:
- Consistency: every other daemon state (`agents`, `messages`, `tasks`) lives in sqlite.  An in-memory map would be a one-off pattern for a niche feature.
- Testability: tests can inspect the table directly, same as they do for other features.
- Observability: a user debugging "why isn't my pre-reg working" can `sqlite3 data.db 'SELECT * FROM codex_pane_pre_registrations;'`.
- Restart behavior: pre-regs shorter than TTL survive a fast daemon bounce (e.g., dev restart).  Launchers that have already exec'd codex don't have to re-register.  Rows older than TTL are ignored and GC'd on next write.

**Alternatives considered**:
- In-memory Map: rejected — inconsistent with project style.
- File on disk: rejected — all the downsides of sqlite without the query benefits.

### D2: Pane is the primary key, UUID is a correctness check

**Choice**: `pane_id` is the PK.  The stored `xats_agent_id` is used at register time to verify the UI process running in that pane is the one the launcher intended (i.e., its argv contains `xats.agent_id="<stored uuid>"`).

**Rationale**:
- The disambiguator we actually need is pane.  UUID is only there to detect "stale pre-reg — user killed their original codex in this pane and started a different tool, don't mis-bind".
- Keeping pane as PK makes "last write wins" trivially correct on re-launch.
- Using UUID as PK would invite duplicate rows for the same pane when launchers race, complicating GC.

**Alternatives considered**:
- `(pane_id, xats_agent_id)` composite PK: overkill, and would let stale rows accumulate.
- UUID as PK: see above.

### D3: Auto-bind only fires when the pending match is unique

**Choice**: When `register_agent` (client=codex, no ui_pid) arrives, the daemon collects all unexpired pre-regs, for each one runs `tmux list-panes` + `ps` on the matching pane to confirm argv contains the stored UUID, and auto-binds only if exactly **one** pre-reg passes this check.  Zero or multiple matches → fall through to existing no-pane behavior.

**Rationale**:
- Safety: binding the wrong pane silently would be a much worse user experience than the current no-pane hint.  "Refuse to guess" is the correct default for ambiguous state.
- Multi-match is rare in practice (one launcher per pane at a time), but can happen when multiple codex sessions start inside the same daemon lifetime and none of them registers yet — letting the registers race and each one attach to its own pre-reg.

**Alternatives considered**:
- Take the oldest / newest pending match: rejected — fragile, and the "correct" ordering depends on which codex UI the agent actually lives in, which is exactly what we don't know.
- Require the agent to pass `xats_agent_id`: rejected — defeats the whole point of the design, since the agent can't read its own UUID from env or cwd.

### D4: Launcher → daemon path is a new `cross-agent-teams-mcp` subcommand, not raw curl

**Choice**: Add a CLI subcommand `cross-agent-teams-mcp pre-register-codex-pane --pane <id> --agent-id <uuid> [--ttl <seconds>]` that opens a short-lived MCP client connection to the running daemon (using the existing auth/port discovery the agent processes already use) and invokes the `pre_register_codex_pane` tool.  The updated `free-xats-codex` shell function calls this before `exec codex`.

**Rationale**:
- Matches the project's existing layering: everything else goes through MCP.  An HTTP bypass route would be a second, parallel API surface.
- Port/token/auth discovery is already solved in the daemon client path.  A `curl` fallback would force users to hard-code ports or pass tokens manually.
- Makes the feature testable end-to-end from the CLI boundary without launching a browser or codex.

**Alternatives considered**:
- Dedicated unauthenticated HTTP endpoint: rejected — breaks auth model.
- `tsx src/cli.ts ...` ad hoc: rejected — not a stable user-facing interface.

### D5: Failure inside auto-bind never fails the register call

**Choice**: Wrap the entire pre-reg lookup + tmux/ps scan + `bind_runtime_identity` chain in a try/catch that logs at debug and falls through to the existing no-pane path.  The only thing the caller sees on failure is the unchanged "no usable tmux_pane_id" hint.

**Rationale**:
- `register_agent` succeeding is table stakes.  Runtime identity is a performance / UX optimization, not a correctness guarantee.
- tmux can legitimately be unavailable (CI, bare ssh session).  `ps` can fail under load.  `bind_runtime_identity` can hit a transient sqlite lock.  None of these should regress the register flow.
- Keeping the pre-reg row intact on partial failure lets a second register attempt (or a separate fallback tool) pick it up without the launcher needing to re-run.

### D6: Launcher uses `exec` so `$$` is codex's pid (for future work, not this change)

**Choice**: Update `free-xats-codex` to `exec codex ...`.  This change doesn't depend on it, but it lowers a future cost: once codex is the caller's pid, anything we eventually want to correlate via `$$` (if codex ever exposes thread info through it) will "just work" without another round trip.

**Rationale**: cheap now, helpful later.  Does NOT affect this change's correctness.

## Risks / Trade-offs

- **[Launcher lacks `$TMUX_PANE`]** User runs `free-xats-codex` outside tmux → launcher silently skips the pre-register call → registration falls back to existing no-pane path → tmux binding unavailable for that session. **Mitigation**: acceptable, documented behavior.  No regression vs current behavior.  Launcher prints a one-line "[xats] pre-register skipped: not in tmux" notice so the user understands.
- **[Daemon restart between pre-reg and register]** Launcher pre-registers, then daemon restarts before codex calls `register_agent`.  Rows persist in sqlite; if TTL hasn't elapsed, the match still succeeds.  If TTL has elapsed, fall-through is clean.  **Mitigation**: covered by sqlite persistence + TTL.
- **[User kills codex UI in a pane and starts a different tool with the same pid]** Pre-reg row still has the old UUID.  When register arrives (e.g., from an unrelated future codex session in the same pane), the argv UUID check rejects the match.  **Mitigation**: the UUID verification step (D2) prevents mis-binding; worst case is "no auto-bind, user sees no-pane hint".
- **[Concurrent registers race for the same pre-reg]** Two codex agents somehow end up in the same pane's pre-reg (shouldn't happen but theoretically possible during testing).  The first one consumes the row; the second sees no match and falls through.  **Mitigation**: SQLite `DELETE ... RETURNING` (or `BEGIN IMMEDIATE` transaction) serializes consumption.  Design the consume step as a single transaction.
- **[ps parsing differences on non-macOS]** `ps -t <tty> -o pid=,args=` behavior differs slightly across platforms.  Existing `detect_tmux_pane` already handles this; we reuse its ttyProcesses helper rather than rolling our own.  **Mitigation**: reuse, add a test on macOS, gate behavior via the same helper boundaries.

## Migration Plan

1. Schema migration (additive-only): `CREATE TABLE IF NOT EXISTS codex_pane_pre_registrations` runs on daemon startup via existing `applySchema`.  Backward compatible with older daemons (table is ignored by them).
2. New MCP tool `pre_register_codex_pane` shipped alongside the extended `register_agent` behavior.  Existing callers are unaffected until they start invoking the new tool.
3. New CLI subcommand `pre-register-codex-pane` shipped.  Documented in `docs/` with the updated `free-xats-codex` shell snippet.
4. No rollback drama: if the feature is reverted, the table stays empty (launcher stops pre-registering) and `register_agent` silently falls back to pre-existing behavior.

## Open Questions

- Should `pre_register_codex_pane` be callable from any agent, or only from a "launcher" role?  Current plan: open to any caller (like other tools), since the UUID verification step at consume time is the real gate.  If we later see abuse, we can gate it to a role.
- Should the daemon emit an SSE event when a pre-reg is consumed (so users can observe in `cross-agent-teams-mcp events` if they ever add one)?  Out of scope for this change; revisit if we add general observability later.
