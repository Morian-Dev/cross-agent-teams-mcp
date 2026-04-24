## Why

Today, binding a Claude Code host to its channel proxy's `channel_session_id` (csid) requires the host LLM to see the proxy's startup `notifications/claude/channel` hint (carrying the csid text), extract the csid, and then pass it into `register_claude_self({channel_session_id})` or a follow-up `bind_channel(...)`.  When that hint does not reach the LLM's context (timing, harness behavior, or silently-dropped delivery), the host silently falls back to tmux poke delivery and there is no way to recover without restarting the proxy.  The LLM shouldn't need to know csid exists at all — the daemon already has enough information at registration time to do the binding itself.

## What Changes

- Channel proxy registration SHALL carry the proxy's `claude_ui_pid` (its `process.ppid`, i.e. the Claude Code UI process that spawned it) AND its `channel_session_id` on `register_agent`.  The daemon stores both on the `__channel_proxy__` row.
- `register_claude_self` and `register_agent({client:'claude-code', ...})` SHALL, when the caller provides `ui_pid` AND no `channel_session_id` was supplied, best-effort look up a live `__channel_proxy__` row whose `claude_ui_pid == ui_pid` and auto-bind the caller's `delivery` to that proxy's csid.  Failure to find a match leaves delivery unchanged (fallback to tmux / existing behavior).
- When a channel proxy (re)registers with a fresh csid (typical on proxy restart), the daemon SHALL rebind any live host rows whose current `delivery.kind='claude-channel'` still references the proxy's old csid — keyed on same `claude_ui_pid` — to the new csid.
- The deprecated manual binding path (`bind_channel(...)` + startup hint flow) remains for callers that still want to supply csid explicitly.  The proxy's `notifications/claude/channel` startup hint is preserved for backward compatibility but becomes informational rather than required.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities

- `claude-channel-transport`: proxy registration SHALL include `claude_ui_pid` and `channel_session_id`; proxy (re)registration triggers host rebind on csid change.
- `agent-registry`: `register_claude_self` and `register_agent({client:'claude-code'})` auto-bind `delivery.kind='claude-channel'` by matching `ui_pid` against `__channel_proxy__.claude_ui_pid` when caller supplies no explicit `channel_session_id`.

## Impact

- `src/mcp/tools.ts` — `register_claude_self` and `register_agent` handlers gain an auto-bind branch after identity UPSERT.
- `src/agents/*` — repo / schema work:
  - `agents` table gains a nullable `claude_ui_pid INTEGER` column for `__channel_proxy__` rows to store the proxy's parent UI pid.
  - Proxy-lookup query: `SELECT channel_session_id FROM agents WHERE role='__channel_proxy__' AND claude_ui_pid=? AND last_seen_at > ?`.
  - Rebind query on proxy re-registration: find all agents whose `delivery.kind='claude-channel'` + `delivery.channel_session_id != new_csid` + share the same `claude_ui_pid` lineage, and rewrite their `delivery_payload` to the new csid.
- `plugins/cross-agent-teams-channel/src/daemon-client.ts` — proxy's `register_agent` call passes `claude_ui_pid: process.ppid` and `channel_session_id: <csid>` so the daemon can persist them.
- No breaking changes to existing callers: callers that keep supplying explicit `channel_session_id` are unaffected.  Callers that omit it now get auto-binding when a matching proxy is found.
