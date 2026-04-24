## Context

The `cross-agent-teams-channel` proxy is a stdio MCP subprocess spawned by Claude Code.  Its sole job is to:

1. Generate a fresh csid per startup (`randomUUID()`).
2. Register a daemon-side `__channel_proxy__` agent row and call `subscribe_channel_wake({channel_session_id})` on the daemon.
3. Emit a `notifications/claude/channel` startup hint so the host LLM learns the csid and calls `register_claude_self({..., channel_session_id})` / `bind_channel({...})` to bind its own row's `delivery` to that csid.

Step 3 is fragile: the proxy calls `server.notification(...)` fire-and-forget (`proxy.ts:15-28`, `.catch(() => {})`).  If the notification fires before the LLM turn begins, or if Claude Code's `--dangerously-load-development-channels` handler silently drops the payload, the host LLM never sees the csid.  There's no MCP tool to query the csid afterward, so the host row stays `delivery.kind='none'` and poke delivery silently falls back to tmux for the entire proxy lifetime.

Both the host (Claude Code UI process) and the proxy (its stdio subprocess) share a parent-child pid relationship: `proxy.process.ppid === <Claude Code UI pid>`.  `register_claude_self` already recommends passing `ui_pid=$PPID` for runtime binding (`docs/configs/claude-code.md`), so the daemon already sees the UI pid when the host registers.  The proxy can also read its own `ppid` at startup.  This shared integer is the key that lets the daemon match host ↔ proxy without LLM cooperation.

## Goals / Non-Goals

**Goals:**

- The LLM does not need to know that `channel_session_id` exists.  `register_claude_self({name, project_dir, ui_pid})` alone suffices for claude-channel delivery to work.
- Race-free regardless of which party registers first (proxy-before-host and host-before-proxy both converge to a bound state).
- Proxy restarts (new csid per run) transparently rebind live host rows that share the same `claude_ui_pid`.
- Existing explicit-csid callers (those who still pass `channel_session_id` to `register_claude_self` / `register_agent` / `bind_channel`) keep working unchanged.

**Non-Goals:**

- Do NOT remove the startup hint notification or the `bind_channel` tool — they remain as backward-compat paths.
- Do NOT introduce any new MCP tool on the proxy side.  The proxy keeps its current register → subscribe → notify sequence; only the arguments it passes to `register_agent` change.
- Do NOT attempt cross-host migration (no "find proxy by directory" or "find proxy by tty" fallback).  Only `claude_ui_pid` matching; if it's missing, the caller falls back to the old behavior (tmux / explicit csid).
- Do NOT persist `claude_ui_pid` for non-proxy agents.  This field is written only for `role='__channel_proxy__'` rows.

## Decisions

### Decision 1: `claude_ui_pid` as the match key

Use `proxy.process.ppid` == `host.ui_pid` as the sole matching key.

**Alternatives considered:**

- *tmux pane id*: proxy is a non-interactive subprocess, it has no owning pane.  Could be inferred by walking up the process tree to the UI pid and then reusing the host's pane-detection, but that duplicates logic and is no cleaner than just using the UI pid directly.
- *working directory / `.mcp.json` path*: Claude Code can run multiple instances in the same directory (different tmux windows).  This would collide.
- *Shared Claude Code "session id"*: no such identifier is exposed to either the proxy or the daemon.

**Rationale:** `ppid` is a hard system fact — the proxy IS a child of Claude Code.  It's unique-per-running-Claude-Code-process.  No ambiguity, no collision, no extra plumbing.

**Risk:** if the proxy is ever started outside Claude Code (e.g. user launches it directly for testing), `process.ppid` will be the shell pid, which won't match any host's `ui_pid`.  Auto-bind simply won't trigger in that case — the explicit-csid path still works.

### Decision 2: Schema — add `claude_ui_pid` column to `agents`

Add `claude_ui_pid INTEGER` (nullable).  Only populated for `role='__channel_proxy__'` rows.

**Alternatives considered:**

- *Separate `channel_proxies` table*: cleaner separation, but adds a second table, a second repo, and a join on register_claude_self's hot path.  One nullable int column is simpler.
- *Store in `delivery_payload` for the proxy row*: the proxy's row currently has `delivery.kind='none'` (it's a proxy, not a delivery target).  Would conflate two concepts.

**Rationale:** column-level additive migration matches the existing pattern (`delivery_kind`, `opencode_base_url`).  The additive migration is idempotent and cheap.

### Decision 3: Matching algorithm on host register

When `register_claude_self` or `register_agent({client:'claude-code'})` is invoked AND the caller supplies `ui_pid` AND the caller does NOT supply `channel_session_id`:

```
SELECT agent_id, delivery_payload
FROM agents
WHERE role='__channel_proxy__'
  AND claude_ui_pid = :ui_pid
  AND last_seen_at > now() - 5 minutes
ORDER BY last_seen_at DESC
LIMIT 1;
```

If a row is found, extract its `channel_session_id` from `delivery_payload`, then execute the same write as `bind_channel` (write caller's `delivery_kind='claude-channel'`, `delivery_payload=json_object('channel_session_id', csid)`).  Additionally, validate that a live `ChannelWakeFanout` sink still exists under that csid (the proxy's MCP session might have just died); if not, skip the bind and behave as if no match was found.

**Rationale:** `last_seen_at > 5min` filters out dead proxies whose rows haven't been cleaned.  `LIMIT 1` handles the edge case (should be unreachable by construction) of two rows with the same `claude_ui_pid`.  Sink check closes the tiny race window between proxy row still being fresh and proxy MCP session already gone.

### Decision 4: Proxy-side — store csid + claude_ui_pid on proxy's row

The proxy's existing `register_agent` call in `plugins/cross-agent-teams-channel/src/daemon-client.ts:58-68` currently passes `{client, client_name, model, role, name, team}`.  Extend it to pass:

- `claude_ui_pid: process.ppid` — stored on the proxy's own row.  **This required extending `register_agent` schema** to accept this top-level field gated to `role='__channel_proxy__'`.
- `delivery: {kind: 'claude-channel', channel_session_id: <csid>}` — stored on the proxy's own row using the existing `register_agent` delivery field.  This is semantically a little odd (the proxy itself isn't a poke target), but it's the existing write path for csid persistence and avoids a new column.  The proxy is filtered out of peer `list_agents` by its `role='__channel_proxy__'` already.

Alternative considered: introduce a separate `subscribe_channel_wake` side-effect that also stores `(claude_ui_pid, csid)` keyed by proxy session.  Rejected because the lookup query then needs to join ChannelWakeFanout state (which is in-memory only, not queryable from SQL).

**Rationale:** reusing `delivery_payload` for the proxy row makes the lookup a single indexable SELECT and keeps csid persistence out of pure in-memory state.  The `claude_ui_pid` column makes the filter fast.

### Decision 5: Host-first race — defer via the "reactive rebind" path

If the host registers BEFORE the proxy registers (rare, but possible on very fast agent startups), the SELECT returns no match → auto-bind doesn't fire.  The host stays in `delivery.kind='none'`.

When the proxy's subsequent `register_agent` succeeds, the daemon SHALL, as part of the proxy's registration write:

1. Look up hosts in the same team with `delivery.kind='none'` and `runtime_ui_pid = proxy.claude_ui_pid` (if host's runtime_ui_pid was persisted during its register_* call).
2. Write those hosts' `delivery_kind='claude-channel'` / `delivery_payload=json_object('channel_session_id', new_csid)`.

This requires `register_claude_self` to persist `ui_pid` onto the host row (ideally as the existing `runtime_ui_pid` column, which already exists per the `bind_runtime_identity` spec).  If the host doesn't pass `ui_pid`, no rebind can target it — consistent with the documented strong recommendation.

**Alternatives considered:**

- *Poll on the host side* — would require a new loop and creates ordering surprises.
- *Return a "pending" marker and rely on client to retry* — pushes complexity to the client.

**Rationale:** the reactive rebind is a single extra SQL statement on proxy registration, which already runs once per proxy lifetime.  O(number of hosts sharing ppid), typically ≤ 1.

### Decision 6: Proxy-restart — also use the reactive rebind path

Proxy restart (new csid) is the same code path as Decision 5: when the proxy re-registers with a new csid, find all hosts in the same team whose `delivery.kind='claude-channel'` AND `runtime_ui_pid = proxy.claude_ui_pid` AND `delivery.channel_session_id != new_csid`, and update their `delivery_payload` to the new csid.

This covers both "host's prior proxy died, new one started" and the initial "host registered before proxy" case from Decision 5 under one query.

### Decision 7: `register_agent({client:'claude-code'})` treated identically

`register_claude_self` is a thin wrapper; the auto-bind branch lives on the shared internal path behind both tools.  Any `register_agent` call whose effective `client='claude-code'` and whose caller supplies `ui_pid` but no `channel_session_id` gets the auto-bind attempt.  Other clients (`codex`, `opencode`, `custom`) are untouched.

## Risks / Trade-offs

- **Proxy died but row is still fresh** → Mitigation: the sink-check (Decision 3) detects this inline during host register; we skip the auto-bind and return the normal response.  The next proxy startup + reactive rebind (Decision 5/6) will cover the host once the proxy comes back.
- **Two Claude Code processes with the same ppid (impossible via OS, but defensive)** → Mitigation: `LIMIT 1 ORDER BY last_seen_at DESC` ensures deterministic behavior even in theoretical duplicates.
- **Caller doesn't pass `ui_pid`** → Silent behavior degradation: no auto-bind, falls back to tmux.  Documented in `register_claude_self`'s description: auto-bind requires `ui_pid`.  Same recommendation that already exists for tmux runtime binding.
- **Test surface** → Two new integration tests: (a) host registers first, proxy registers second, host's delivery becomes claude-channel; (b) proxy restarts with new csid, bound host rewrites payload automatically.  Cover both ends of the timing race.
- **Backward compat** → All existing tests for `register_claude_self` / `register_agent` without csid currently assume `delivery.kind='none'`.  New behavior changes a subset of those: tests running in-process without a live proxy still see `delivery.kind='none'`.  Only tests with a live proxy subprocess see the new auto-bind.  Existing test files should not need changes.

## Migration Plan

1. Ship daemon changes: schema migration (additive column) + host-register auto-bind + proxy-register reactive rebind.
2. Ship proxy plugin changes: pass `claude_ui_pid` and `delivery` on `register_agent`.
3. Existing deployments: on daemon restart, migration adds `claude_ui_pid` column with NULL defaults.  Existing `__channel_proxy__` rows have NULL claude_ui_pid until they re-register.  Host auto-bind won't find them until then — acceptable since the proxy reconnects every ~500ms on daemon restart anyway (`runReconnectingProxy`).
4. No rollback complexity: if the feature is later disabled, drop the auto-bind branch; the column can stay unused or be dropped separately.

## Open Questions

- Do we want to surface a `hint` in `register_claude_self` response when `ui_pid` was NOT supplied, so the caller sees "you'd have gotten auto-bind if you passed ui_pid"?  Probably yes — the existing `hint` field on missing-pane-id already serves the same purpose; we can extend its text to mention channel binding too.  Deferred to implementation.
- Should proxy rows time out faster than 5 minutes for the "live proxy" filter?  A proxy that disappears leaves its row with `last_seen_at` frozen.  The MCP session close handler already runs `ChannelWakeFanout.detachBySession` but does NOT currently delete the `agents` row.  The sink-check in Decision 3 handles the dead-sink case; 5 minutes is fine as a secondary filter.
