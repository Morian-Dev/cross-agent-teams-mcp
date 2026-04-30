## Why

The channel proxy's startup_bind_hint currently recommends that Claude Code callers pass `channel_session_id=<csid>` to `register_claude_self` / `register_agent({client:'claude-code'})` as the primary registration path. But if that csid is stale or came from a different Claude Code CLI instance, and the caller also supplies `ui_pid`, the explicit csid overrides the pid-based auto-bind — the caller is silently bound to a proxy sink that is not actually connected to its own Claude CLI. The daemon marks wake-hint delivery as `delivered` because a live subscriber exists on that csid, but the poke never reaches the intended host. We hit this failure live during a poke connectivity test: a caller with `$PPID=27341` (csid `f256fc1a-...`) was told by the startup hint to use csid `45818c22-...` (belonging to an older Claude CLI with pid `89785`), silently mis-bound, and the subsequent reply from gpt never woke the user's Claude.

## What Changes

- Rewrite `plugins/cross-agent-teams-channel/src/cli.ts::buildStartupHint` so the hint recommends `register_claude_self({name, ui_pid: $PPID})` (or `register_agent({client:"claude-code", name, model, ui_pid: $PPID})`) as the PRIMARY binding path. Do NOT suggest passing `channel_session_id` to these tools. Keep the csid visible in the hint text, but frame it solely as the argument for `bind_channel({channel_session_id})` — the low-level rebind path used when an already-registered host needs to switch to a fresh csid.
- **BREAKING** the hint text: downstream callers that parsed the hint for a "pass this csid to register_claude_self" recipe must switch to the ui_pid-based recipe. The csid is still present in the content (for `bind_channel` fallback), but the primary recipe changes.
- Add a csid-vs-ui_pid consistency check to `register_claude_self` AND `register_agent({client:"claude-code"})`: when the caller supplies BOTH `ui_pid` AND `channel_session_id`, the daemon MUST look up the live `__channel_proxy__` row keyed on `claude_ui_pid = <ui_pid>` AND `team = <caller team>` AND `last_seen_at > now() - 5 min`. If such a proxy row exists AND its persisted csid differs from the supplied `channel_session_id`, the tool MUST reject the call with `{error: 'channel_session_id_ui_pid_mismatch', detail: {ui_pid_matched_csid, supplied_csid}}` and write NO agent row state. If no matching live proxy row exists (the ui_pid has no live proxy), the call proceeds as today — no mismatch can be detected.
- Extend `AutoBindChannelService` with a read-only `lookup({ui_pid, team})` that returns the live proxy's csid (or `undefined`). Reuse it from both the auto-bind path (csid omitted) and the new consistency check (csid supplied). Preserve the existing `run(...)` write path unchanged.
- Tests: update the proxy startup-notification test to assert the new hint wording (recommends `ui_pid`, keeps csid present). Add unit tests for the mismatch rejection on both `register_claude_self` and `register_agent({client:"claude-code"})`, plus the "no live proxy for ui_pid → no rejection" case.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `claude-channel-transport`: MODIFIED — the "Channel proxy startup sequence" requirement's step 6 and the "proxy emits startup channel notification with csid and bind instruction" scenario change to reflect the new hint content. The hint MUST still mention the csid (for `bind_channel`), but MUST additionally mention `register_claude_self` with `ui_pid` as the primary path, and MUST NOT recommend passing `channel_session_id` to `register_claude_self` / `register_agent`.
- `agent-registry`: MODIFIED — add a new requirement "register_claude_self and register_agent claude-code reject channel_session_id that conflicts with ui_pid's live proxy csid" that defines the mismatch rejection behavior for both tools.

## Impact

- Code: `plugins/cross-agent-teams-channel/src/cli.ts` (hint rewrite), `src/mcp/auto-bind-channel.ts` (new `lookup` method, same SQL as existing `run`), `src/mcp/tools.ts` (new consistency check in the `register_agent({client:'claude-code', ui_pid, channel_session_id})` and `register_claude_self({ui_pid, channel_session_id})` branches).
- Tests: `plugins/cross-agent-teams-channel/tests/proxy-startup-notification.test.ts` (updated expectations), new tests for `register_claude_self` mismatch + `register_agent({client:'claude-code'})` mismatch + "no live proxy → no rejection".
- Docs: no README change required — the hint text is what the LLM sees, not what operators read. `docs/configs/claude-code.md` (if it mentions passing csid explicitly) may need a small note, to be verified during apply.
- Downstream users: any script or LLM prompt that hard-codes "pass `channel_session_id` to `register_claude_self`" must switch to the ui_pid-only recipe. The error code `channel_session_id_ui_pid_mismatch` is NEW — callers that previously would have bound silently to the wrong csid now see a clear error and can recover by either dropping the csid (let auto-bind take over) or calling `bind_channel` explicitly after registration.
- Schema: no change.
- Operator cutover: none — this is a pure code + behavior tightening. New binaries pick up the new hint + check on next daemon restart.
