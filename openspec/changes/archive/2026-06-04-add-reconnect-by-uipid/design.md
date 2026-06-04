## Context

`register_agent` already persists `runtime_ui_pid` (the Claude UI process id, `$PPID`) on each `claude-code` agents row and uses it to auto-bind the channel and runtime pane. After a context clear, the Claude process — and therefore `$PPID` — is unchanged, but the agent's conversation memory of its own `(team, name)` is gone. The daemon only offers `findByIdentity(device, team, name)` (forward lookup); there is no `ui_pid -> identity` reverse lookup, so the agent cannot recover its name on its own and must re-ask the user.

The reverse-lookup is already half-present: `reactiveRebindHosts` (`src/storage/agents-repo.ts`) queries `WHERE ... runtime_ui_pid = ?` to rebind hosts during channel proxy reactive rebind. The same SQL shape, returning identity columns, is all that is needed.

## Goals / Non-Goals

**Goals:**
- One tool call, `reconnect({ ui_pid })`, recovers a prior `claude-code` identity after a context clear.
- Reuse the existing `agent_id`, cross-session takeover, channel auto-bind, and runtime-pane auto-bind — no new binding logic.
- Deterministic disambiguation: single match reuses; zero match guides to `register_agent`; multiple matches return candidates ordered by `last_seen_at`.
- Tool self-describes its trigger phrases (including Chinese) so no skill/slash-command is needed.

**Non-Goals:**
- Codex reconnect (keyed on `$CODEX_THREAD_ID`, not `ui_pid`) — explicitly out of scope.
- Auto-registering on a zero-match miss — `reconnect` only reconnects existing identities.
- Any agents-table schema migration — `runtime_ui_pid` already exists.
- Remote-device (`device != 'local'`) recovery.

## Decisions

### Decision: parameter name is `ui_pid`, not `pid`/`ppid`
`register_agent` already takes `ui_pid` and the DB column is `runtime_ui_pid`. Using `ui_pid` keeps the same value under the same name across both tools. `$PPID` is the shell-side source of the value, documented in the description, but the parameter stays `ui_pid` for consistency. Alternative (`ppid`) rejected: it would name the same value differently in two adjacent tools.

### Decision: new capability `agent-reconnect`, not a modification of `agent-registry`
`reconnect` is a distinct tool with its own surface and requirements, and the `agent-registry` spec is already ~1200 lines. Isolating it keeps both specs focused. It reads only existing columns, so no `agent-registry` requirement actually changes. Alternative (delta into `agent-registry`) rejected to avoid bloat and coupling.

### Decision: reuse the register path rather than reimplement
On a single match, `reconnect` resolves `(device, team, name)` from the matched row and then drives the same internal registration/takeover/auto-bind path `register_agent` uses, supplying the recovered identity instead of caller-provided `name`. This guarantees identical takeover and binding semantics and avoids divergence. Alternative (bespoke rebind inside reconnect) rejected: it would duplicate and risk drifting from `register_agent`.

### Decision: ordering and disambiguation by `last_seen_at desc`
A single UI process can leave multiple historical rows (e.g. after a rename, the old `(team, name)` row keeps the same `runtime_ui_pid`). The most-recently-active row is the best guess, so candidates are ordered `last_seen_at desc`; on a tie-count > 1 the tool returns `ambiguous` and lets the user choose rather than guessing.

## Risks / Trade-offs

- [PID reuse — a stale row could be falsely matched if the OS reassigns a dead Claude process's `$PPID` to an unrelated new process] → Mitigation: `reconnect` returns each candidate's `last_seen_at`; the caller surfaces it, and the implementation MAY warn when the matched row's `last_seen_at` is older than a threshold. Low probability (requires the original Claude to have exited and the exact PID to be reused on the same host); not hard-blocked to avoid over-engineering. Tracked as an open question below.
- [Multiple live Claude windows in the same project dir] → Not a concern for `ui_pid` matching: each Claude UI process has a distinct `$PPID`, so `ui_pid` disambiguates them; the multi-match path only triggers on historical rename residue, which `ambiguous` handles.
- [Channel proxy not yet rebound when `reconnect` runs] → Same timing characteristics as `register_agent`'s auto-bind; reusing that path means reconnect inherits its existing behavior and any future fix automatically.

## Open Questions

- Should the stale-candidate warning be a hard reject above some `last_seen_at` age, or an advisory field only? Current lean: advisory only (return `last_seen_at`, optional soft warning), revisit if PID-reuse false matches are ever observed in practice.
