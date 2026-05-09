## Context

Channel proxies are spawned per Claude Code UI process to mediate the `claude-channel` delivery path. Each proxy registers itself as an `agents` row with `role='__channel_proxy__'` and a `claude_ui_pid`, and carries a `channel_session_id` that non-proxy agents bind into their `delivery_payload` via `register_agent` (auto-bind) or `bind_channel`. Once registered, a proxy never deregisters itself: even when its UI exits, the row remains as a permanent "tombstone" until something deletes it. Nothing currently does — `runCleanup` only operates on mailbox-derived tables.

Concrete observed state in a single working environment: team `default` had **121 agents rows** (14 business + 107 channel proxies) and `list_agents` returned a 51,301-character JSON. Different MCP clients hit their response-size ceilings at different points, producing inconsistent views of the same team. The bug surfaced as "claude-code can't see cursor" but the root cause is response-size variance driven by channel proxy accumulation.

Two pieces of infrastructure are involved:
- **Read-side**: `AgentsRepo.list({team})` returns every row in the team, surfaced via the `list_agents` MCP tool.
- **Write-side**: channel proxies register on each Claude Code launch; nothing deletes them.

Both touch the same root cause but are independent fixes that need to land together to fully close the loop.

## Goals / Non-Goals

**Goals:**

- `list_agents` MCP responses contain only business agents, regardless of how many channel proxies exist in the team.
- Channel proxy rows that have been offline for ≥ 30 days are reaped from the `agents` table by the existing periodic cleanup, with the same TTL as mailbox-derived rows.
- Live `claude-channel` delivery never breaks because of GC: a stale proxy still referenced by a non-proxy agent's `delivery_payload` survives.
- All cleanup deletions remain atomic in a single SQLite transaction.

**Non-Goals:**

- We do NOT add an `include_internal: true` opt-in to `list_agents`. If a future ops scenario needs proxy visibility, a separate spec change can introduce it.
- We do NOT change channel proxy registration, bind, or delivery semantics. Proxies still register and route exactly as they do today.
- We do NOT introduce a new cleanup interval or retention knob. The 30-day threshold is reused verbatim.
- We do NOT GC non-proxy `agents` rows, even after long offline periods. Business agents retain their indefinite-retention contract.
- We do NOT alter `send_message`, `send_message_by_id`, `bind_channel`, or any other tool's behaviour.

## Decisions

### D1. Filter at the storage layer, not the tool layer

`AgentsRepo.list({team})` will gain an optional `excludeRoles?: string[]` parameter (or equivalent), and the `list_agents` tool will pass `excludeRoles: ['__channel_proxy__']`. Filtering at the storage layer keeps the SQL minimal (`AND role <> '__channel_proxy__'`) and avoids materializing 100+ rows just to discard them in JS.

**Alternatives considered:**
- Filter inside the tool handler after `list()` returns — wastes work materializing rows we throw away.
- Add a hardcoded `WHERE role <> '__channel_proxy__'` directly in `list()` with no parameter — too rigid; we want internal callers (if any future ones appear) to retain the option to see proxies.

### D2. The exclusion is unconditional on the `list_agents` wire surface

No `include_internal` flag, no per-team override. Channel proxies are infrastructure; if a debugger needs to see them, they can query the SQLite DB directly. Keeping the public tool monotonic (one shape, one filter) avoids the trap of clients silently relying on the unfiltered shape.

**Alternatives considered:**
- Add `include_internal?: boolean` parameter — premature flexibility per CLAUDE.md guidelines, and risks clients defaulting to it for "completeness".

### D3. GC adds a fourth deletion step inside the existing `runCleanup` transaction

We do NOT introduce a new cleanup function. Instead, `runCleanup` adds a fourth step after `events` deletion: prune `agents` rows where `role='__channel_proxy__' AND last_seen_at < ageCutoff` AND not referenced as a live `channel_session_id`.

The transactional guarantee already covered by the existing `db.transaction(...)` extends to the new step. The returned `deleted` count is incremented by the prune count.

**Alternatives considered:**
- Separate `pruneStaleChannelProxies()` function called separately on the same interval — splits the contract; each call lands as its own transaction, which is harmless but loses the "one cleanup = one transaction" simplicity.

### D4. Live-reference guard is implemented as a SQL `NOT EXISTS` subquery

```sql
DELETE FROM agents
WHERE role = '__channel_proxy__'
  AND last_seen_at < ?
  AND NOT EXISTS (
    SELECT 1 FROM agents host
    WHERE host.delivery_kind = 'claude-channel'
      AND host.role <> '__channel_proxy__'
      AND json_extract(host.delivery_payload, '$.channel_session_id')
          = json_extract(agents.delivery_payload, '$.channel_session_id')
  )
```

This is a single statement executed inside the transaction. Channel session ids are O(team-size) to scan; default's 14 non-proxy agents make the inner query trivial. SQLite's `json_extract` is available (the codebase already uses it elsewhere).

**Alternatives considered:**
- Two-step: SELECT live channel_session_ids into JS, then DELETE with `NOT IN (...)` parameter list. Works but adds a round trip and a list-size limit; no benefit over the subquery.
- FOREIGN KEY with ON DELETE RESTRICT between host's `delivery_payload.channel_session_id` and proxy's `channel_session_id` column — would require a real column (it's currently inside a JSON blob) and a schema migration. Out of scope.

### D5. The pruning step does NOT cascade-delete contract subscriptions or related rows

Channel proxies don't subscribe to contracts and don't own tasks. The transaction order keeps `events`/`messages`/`message_delivery_status` deletes before the `agents` prune to ensure no FK reference becomes dangling, since `events.actor_agent_id` may reference proxies in old rows that are also being pruned by the 30-day cutoff. (events for a proxy older than 30d are deleted first; the proxy row is deleted last.)

We verified there are no other FK references from non-deleted tables to `agents.agent_id` for `__channel_proxy__` rows specifically. If a future schema introduces such a reference, this design must be revisited.

### D6. One-shot large delete on first deploy is acceptable

The first cleanup pass after deploy will delete the existing backlog of stale channel proxies (e.g., ~100 rows in default). This runs in a single transaction; SQLite handles delete-of-100 in milliseconds. No batching needed.

## Risks / Trade-offs

- **[Risk] Live-reference guard misses a non-`claude-channel` reference path** → Mitigation: codebase audit in tasks confirms `channel_session_id` is only referenced via `delivery_payload` for `delivery_kind='claude-channel'` agents. The `auto_bind_channel.ts` and `bind_channel.ts` helpers are the only writers; no other column or table stores it. The SQL guard mirrors exactly that path.

- **[Risk] A proxy whose host has been offline > 30d can be pruned, then if the host comes back, channel delivery is silently broken** → Mitigation: Hosts coming back online after 30d offline already lose all unread mail (per the existing 30-day mailbox TTL contract); losing the channel proxy binding too is consistent with that "30 days = forfeit" contract. The host's next `register_agent` would re-establish a fresh proxy via the auto-bind path.

- **[Risk] Removing channel proxies from `list_agents` breaks an undocumented client that relies on counting them for diagnostics** → Mitigation: Internal callers don't use `list_agents` (they use `AgentsRepo.getById` or the SQL directly). External clients querying for "channel proxies" by role would already need to know the magic string `__channel_proxy__`; we judge this group to be empty in practice. If proven otherwise post-deploy, adding `include_internal: true` is a small additive change.

- **[Trade-off] `excludeRoles` parameter is generic but only one role is filtered today** → Acceptable: a parameter named `excludeRoles?: string[]` reads more cleanly than a boolean `excludeChannelProxies?: boolean` and mirrors how SQL `NOT IN (...)` works. If we ever filter another role, no API change is needed.

## Migration Plan

1. Land code change. The npm package version bumps as part of the release flow (not part of this change's scope).
2. On daemon restart with the new code, the first periodic cleanup pass (within 1 hour by default) will prune the existing backlog of stale channel proxies. Operators who want it sooner can restart the daemon and trigger cleanup manually if exposed.
3. Existing `list_agents` callers see a smaller response immediately on first call after upgrade. No client code changes required; the smaller response is strictly a subset of what they'd see if they handled the old response correctly.
4. **Rollback**: revert the version. The dropped channel proxy rows are reconstructed automatically the next time their hosts launch and re-register; no manual data restore needed.

## Open Questions

(none — all decisions resolved during design)
