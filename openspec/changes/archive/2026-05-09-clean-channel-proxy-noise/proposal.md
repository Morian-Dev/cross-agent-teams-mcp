## Why

`list_agents` currently dumps every row in the caller's team — including internal `__channel_proxy__` rows — into a single response, and channel proxy rows accumulate forever because `runCleanup` does not touch the `agents` table. In a real working `default` team this produced **14 business agents + 107 channel proxies** (51,301 chars in one response), which exceeded MCP client size limits and caused different clients to truncate at different points: `claude-code` saw the first ~9 entries (cursor invisible), `cursor` ingested all 121 then filtered client-side. Two agents in the same team appeared not to be in the same team.

`__channel_proxy__` rows are infrastructure for the `claude-channel` delivery path. They are not legitimate `send_message` recipients and have no place in a "who is in my team" view. Combined with unbounded growth, they make `list_agents` unreliable as the team grows.

## What Changes

- `list_agents` SHALL exclude rows with `role='__channel_proxy__'` from its response by default. No new opt-in flag is added — channel proxies are pure infrastructure and the public agent listing has no reason to surface them.
- The 30-day cleanup routine SHALL extend to delete `agents` rows where `role='__channel_proxy__'` AND `last_seen_at < now - 30d`. Non-proxy agent rows are still retained forever, preserving the existing contract for business agents.
- The cleanup MUST avoid orphaning live `claude-channel` delivery: a channel proxy row that is still referenced as the active `channel_session_id` by any non-proxy agent's `delivery_payload` MUST NOT be deleted, even if its `last_seen_at` is past the threshold.
- Internal callers (`AgentsRepo.getById`, channel-wake fanout, delivery dispatch) continue to see channel proxy rows — only the MCP wire `list_agents` surface and long-term retention behaviour change.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `agent-registry`: `list_agents` response semantics narrow from "all rows in team" to "all non-proxy rows in team". The contract that channel proxies are internal-only is made explicit at the spec level.
- `events-outbox`: the existing requirement "cleanup MUST NOT touch the `agents` table" relaxes to permit deletion of stale `__channel_proxy__` rows under the same 30-day threshold, with a referential-integrity guard against deleting rows still bound to live `claude-channel` delivery.

## Impact

- **Code**: `src/mcp/tools.ts` (`list_agents` handler), `src/storage/agents-repo.ts` (`AgentsRepo.list`), `src/daemon/cleanup.ts` (`runCleanup`).
- **Behaviour**: `list_agents` responses shrink dramatically for teams with many channel proxies; clients that previously truncated will now see the full business roster.
- **Data**: Existing stale channel proxy rows (`last_seen_at` past 30d) are deleted on the next cleanup pass after deploy. This is a one-time large delete; non-stale proxies and all business agents are unaffected.
- **No breaking changes** for `send_message`, `send_message_by_id`, `bind_channel`, `subscribe_channel_wake`, the channel-wake fanout, or any internal lookup path. Channel proxies are still registered and looked up exactly as before; only their visibility on `list_agents` and their long-tail persistence change.
