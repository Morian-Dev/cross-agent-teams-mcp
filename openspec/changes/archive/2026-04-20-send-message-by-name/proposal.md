## Why

`send_message` currently only accepts `to_agent_id` (UUID). Combined with `list_agents` being hard-coded to the caller's team (src/mcp/tools.ts:229), callers that want to cross-team-message `(team=X, name=Y)` have no programmatic way to resolve Y's UUID. Users naturally think in `(team, name)`, not UUIDs, so today's workarounds — pasting UUIDs by hand, or waiting for the target to reply first so the caller learns `from_agent_id` via inbox — are awkward and break the "agents talk to agents without human plumbing" story.

The `agents_identity_idx` UNIQUE INDEX on `(team, name)` already guarantees unambiguous resolution. Exposing that to `send_message` as an optional `to_agent_name` parameter closes the UX gap with the smallest possible surface-area change, without introducing new discovery tools whose scoping and privacy questions are still open.

## What Changes

- `send_message` MCP tool gains an optional `to_agent_name: string` parameter, as an alternative to `to_agent_id`.
- Exactly ONE of `to_agent_id` / `to_agent_name` must be provided; the daemon SHALL return `{ error: 'missing_recipient' }` when neither is given and `{ error: 'ambiguous_recipient' }` when both are given.
- When `to_agent_name` is supplied, the daemon resolves `(to_team ?? caller.team, to_agent_name)` → UUID via `AgentsRepo.findByIdentity`. If the lookup returns no row, the daemon SHALL return `{ error: 'unknown_recipient' }` (same error as the UUID path, for consistency).
- `SendMessageService.send` internally normalises to a resolved `to_agent_id` before the existing insert + auto-poke pipeline; the success envelope is unchanged (`recipients[]` always holds the resolved UUID).
- The `send_message` MCP tool description SHALL mention `to_agent_name` as the preferred field when the caller knows the target by `(team, name)`, while preserving the existing `to_agent_id` path for backward compatibility.
- `broadcast`, `broadcast_to_role`, `get_inbox`, `poke`, auto-poke fanout, and retry-backoff logic are untouched.
- No DB schema change. No changes to `messages`, `events`, or any index.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `mailbox`: `send_message` input schema and the "requires exactly one recipient field" / "unknown recipient" requirements are extended to accept `to_agent_name` as an alternative routing key alongside `to_agent_id`.

## Impact

- Affected code: `src/mcp/send-message.ts` (SendInput type, service resolution), `src/mcp/tools.ts` (Zod schema, tool description).
- Affected tests: `tests/send-message-zod-schema.test.ts` (schema acceptance / rejection), new unit coverage for the `(team, name)` lookup path.
- No DB migration. No external API shape break — the old `to_agent_id` path keeps working identically.
- Dependencies: reuses existing `AgentsRepo.findByIdentity` and the `agents_identity_idx` UNIQUE INDEX; no new indexes or queries beyond what that helper already issues.

## Preconditions

- Change `refactor-mailbox-routing` MUST be archived before this change's archive runs. Its ADDED Requirement `send_message is 1→1 private message only` and MODIFIED Requirement `send_message to unknown recipient` are the targets of this change's MODIFIED entries. Enforced at archive time by `openspec archive` delta application; not encoded as a tasks.md task.
