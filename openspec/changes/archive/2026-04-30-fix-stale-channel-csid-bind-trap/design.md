## Context

The `cross-agent-teams-channel` plugin runs as an stdio MCP server inside each Claude Code CLI process (launched via Claude's `.mcp.json`). At startup the proxy:

1. Generates a fresh `channel_session_id` UUID.
2. Registers itself as `role='__channel_proxy__'` with `claude_ui_pid = process.ppid` (its parent = the Claude CLI) and `delivery = { kind:'claude-channel', channel_session_id:<csid> }`.
3. Subscribes that csid's sink on the daemon via `subscribe_channel_wake`.
4. Sends a `notifications/claude/channel` back to its host Claude stdio with a startup hint telling Claude "this is your csid; here's how to bind".

The existing hint text (`plugins/cross-agent-teams-channel/src/cli.ts::buildStartupHint`) recommends two primary paths:

- `register_claude_self({name, channel_session_id: <csid>})`
- `register_agent({client:'claude-code', name, model, channel_session_id:<csid>})`

And mentions `bind_channel({channel_session_id})` only as a "rebind" fallback. The `channel_session_id` field is strictly optional on `register_claude_self` / `register_agent({client:'claude-code'})`: when it is supplied, the explicit value wins; when omitted and `ui_pid` is supplied, the daemon's `AutoBindChannelService` looks up the live proxy with matching `claude_ui_pid` and writes its csid.

The trap: when the csid in the hint is from an older Claude CLI instance (e.g., the operator has had multiple Claude sessions in this workspace; a stale proxy row lingers on the agents table; the "current" hint got surfaced from an older relay), passing that csid alongside `ui_pid` silently locks the caller to the stale sink. The daemon sees a live subscriber on that csid (the old proxy's subscription is still attached in-memory) and reports `wake_status='delivered'`, but the hint content never reaches the caller's Claude Code. Poke behavior looks broken to the operator even though every layer reports success.

The fix is two-pronged:

- Remove the TEMPTATION: stop recommending callers pass csid to `register_claude_self` / `register_agent` in the first place. `ui_pid` alone is sufficient.
- Catch the remaining cases: if a caller still supplies both ui_pid and csid, validate that the csid is the one that actually corresponds to the caller's Claude CLI.

## Goals / Non-Goals

**Goals:**
- Make the common path `register_claude_self({name, ui_pid: $PPID})` — no csid to copy, no opportunity to drift.
- When ui_pid + csid are both supplied, silently-wrong binding becomes a clear, structured error (`channel_session_id_ui_pid_mismatch`) instead of a silent success.
- Keep the low-level escape hatch: `bind_channel({channel_session_id})` continues to work exactly as today. The hint still surfaces the csid because that's the only input `bind_channel` needs.
- Reuse the existing `AutoBindChannelService` SQL — no new lookup logic, just a read-only `lookup` wrapper to share the query between auto-bind (csid omitted) and consistency check (csid supplied).

**Non-Goals:**
- No change to `bind_channel` itself. It explicitly allows rebinding to any csid the caller chooses; that's its purpose.
- No change to the `register_agent` / `register_claude_self` branches where only csid is supplied (no `ui_pid`). We cannot detect mismatch without `ui_pid`, and this path remains valid for operators who genuinely know which csid they want.
- No GC or cleanup of stale `__channel_proxy__` rows in this change. Those rows age out via `last_seen_at` and are already excluded from auto-bind by the 5-minute live-window check. A dedicated cleanup job is a separate change if it ever becomes necessary.
- No change to the daemon-side `wake_status` accounting. The delivery-status value was never wrong — the csid-vs-pid drift meant the wake was technically delivered to a (wrong) sink. Fixing the binding prevents the drift; the status logic needs no change.

## Decisions

### D1. Rewrite `buildStartupHint` to recommend ui_pid-only registration

**Chosen:** the hint text recommends `register_claude_self({name, ui_pid: $PPID})` (or `register_agent({client:'claude-code', name, model, ui_pid: $PPID})`) as the PRIMARY path. It explicitly tells callers NOT to pass `channel_session_id` on these tools, and describes `bind_channel({channel_session_id: <csid>})` as a low-level rebind tool. The csid remains in the hint string (it's what `bind_channel` takes), but it is no longer advertised as a register-time argument.

**Rationale:** `ui_pid = $PPID` is universally available inside Claude Code's Bash tool and is a more reliable identity signal than a csid string that the LLM has to copy verbatim. Removing the csid from the primary recipe removes the entire class of stale-csid drift errors at the source.

**Alternative considered:** keep the csid recipe for backwards compatibility and only add the mismatch check (Decision D2). Rejected — the recipe is the trap; leaving it in the hint while the check rejects it is user-hostile.

### D2. Add `channel_session_id_ui_pid_mismatch` rejection in `register_claude_self` + `register_agent`

**Chosen:** when BOTH `ui_pid` AND `channel_session_id` are supplied on `register_claude_self` or `register_agent({client:'claude-code'})`, look up `__channel_proxy__` rows where `claude_ui_pid=<ui_pid>` AND `team=<caller team>` AND `last_seen_at > now() - 5 min`. If a row exists AND its persisted csid differs from the supplied csid, return `{error: 'channel_session_id_ui_pid_mismatch', detail: {ui_pid_matched_csid, supplied_csid}}`. If a row exists AND csids match, proceed as today. If no row matches, proceed as today (no basis to reject).

**Rationale:** this is the second layer of defense for callers who ignore the new hint or come from old scripts. It gives a structured, actionable error instead of silent misbinding. The "no live proxy for ui_pid → proceed" branch preserves today's semantics for callers whose own proxy isn't up yet and who legitimately want to explicit-bind a known csid.

The 5-minute live window reuses the existing `LIVE_WINDOW_MS` constant in `auto-bind-channel.ts`, keeping the consistency check and auto-bind on the same "what counts as live" definition.

**Alternative considered:** always reject when csid doesn't match ui_pid's proxy, even if no live proxy exists. Rejected — a caller can legitimately have no proxy yet (proxy hasn't finished starting) but know a csid from another source (e.g., operator testing `bind_channel` semantics). Rejecting in that case would break a legitimate path without solving the drift problem.

**Alternative considered:** silently rewrite the supplied csid to the ui_pid's matched csid (effectively same as omitting). Rejected — silent rewrites hide caller bugs. An explicit error teaches the caller to stop passing csid; a silent rewrite doesn't.

### D3. Extract a read-only `lookup` method on `AutoBindChannelService`

**Chosen:** add `lookup(input: { ui_pid, team }): { ok: true; channel_session_id } | { ok: false; reason }` that runs the same SQL as the existing `run(...)` method but STOPs before the UPDATE — just returns the csid (or a miss reason). The existing `run(...)` method is kept; it becomes a thin wrapper that calls `lookup` and then writes if live.

**Rationale:** the SQL is identical and has to stay in sync. Putting it in a single private method (`findLiveProxyCsid`) and exposing two public entry points is cheaper than duplicating the query.

**Alternative considered:** inline the query in tools.ts for the new consistency check. Rejected — duplication drifts over time; the 5-minute window and the join semantics should live in one place.

### D4. Keep the legacy notification-content contract ("must contain csid", "must mention bind_channel")

**Chosen:** the scenario assertions "hint content contains the literal csid string" and "hint content mentions `bind_channel`" stay. We ADD new assertions: "hint content mentions `register_claude_self` and `ui_pid`" and "hint content does NOT recommend passing `channel_session_id` to `register_claude_self` / `register_agent`". We can encode the NOT-recommend rule either as a structural assertion on wording (fragile) or as a negative match on a specific forbidden phrase.

**Chosen implementation:** positive assertions only — "mentions `ui_pid`", "mentions `register_claude_self`", "mentions `bind_channel`". No negative phrase assertion; rely on human review + the mismatch check (Decision D2) to catch any regression where csid sneaks back into a register recipe.

**Rationale:** negative-phrase assertions are brittle (wording changes break tests even when behavior is fine). The combination of positive assertions + mismatch-check coverage is sufficient.

## Risks / Trade-offs

- **[Risk]** Existing tests or operator scripts that relied on the old hint wording break on upgrade → **Mitigation:** the failure mode is a rejected test assertion, not a silent behavior regression. Failing loudly is the intended signal; the fix is one-line (update the recipe). Called out explicitly as BREAKING in the proposal.
- **[Risk]** The mismatch check fires on legitimate edge cases (e.g., two `claude_ui_pid=X` proxy rows accidentally exist in the same team at the same time) → **Mitigation:** the lookup uses `ORDER BY last_seen_at DESC LIMIT 1`, matching the existing auto-bind behavior. If there are duplicates, we pick the most-recently-seen; the caller hit would be the same proxy row the daemon is already treating as canonical.
- **[Risk]** A race where the proxy row appears between the check and the subsequent `bindChannelSvc.bind` call could cause the bind to see a csid the check didn't compare against → **Mitigation:** not a real risk — `bindChannelSvc.bind` requires the csid to have a live sink in `ChannelWakeFanout`, which is orthogonal to the pid-based lookup. The mismatch check is about ensuring the caller's intent aligns with its pid's proxy; the sink-live check (already enforced by `bindChannelSvc.bind`) is a separate guard.
- **[Trade-off]** Callers who want to bind to a csid from a DIFFERENT Claude CLI (cross-CLI delivery?) lose a path. This is not a real use case — each Claude CLI has exactly one channel proxy, and cross-CLI wake delivery is not supported anywhere else. No loss.

## Migration Plan

Pure code change. No schema migration, no operator cutover steps beyond "rebuild and restart the daemon". Existing callers that pass csid to `register_claude_self` stop working only in the specific mis-bind case we want them to stop (mismatched csid vs ui_pid); matching csid still works, csid-only without ui_pid still works.

## Open Questions

None. Design decisions were established from direct user instruction ("1,2 都直接改"). No dependencies on external systems; no product-level uncertainty.
