## Why

After `add-codex-appserver-delivery` shipped, two defense-in-depth gaps in the delivery abstraction became live in production:

1. `parseDeliveryRow` returns whatever DB payload it reads without validating the kind discriminant or required variant fields. A corrupt row (unknown `delivery_kind`, missing `thread_id` / `channel_session_id` / `ws_url`) silently yields a structurally-invalid `DeliverySpec` that the dispatcher later accesses.
2. `list_agents` returns the full `DeliverySpec` payload — including `thread_id`, `ws_url`, and future `auth_token_ref` — to every same-team agent. The routing-only metadata leaks to peer agents that have no need for it.

Both were flagged as WARNING during the earlier `refactor-delivery-abstraction` review and deferred as latent. They are no longer latent: codex-appserver rows are writable today.

## What Changes

- **agent-delivery**: `parseDeliveryRow` MUST validate each kind's required fields and throw `corrupt_delivery_payload` on unknown kind, empty/missing `channel_session_id` for `claude-channel`, or missing `thread_id` / `ws_url` for `codex-appserver`. `auth_token_ref`, when present, must be a non-empty string.
- **agent-registry**: `list_agents` MUST project each row to a public shape that hides routing-only delivery fields. Peers see only the delivery `kind` discriminant plus the derived legacy `channel_session_id` accessor. `thread_id`, `ws_url`, `auth_token_ref` never leave the MCP boundary.
- Internal repo return shapes (`AgentsRepo.getById`, `AgentsRepo.list`) remain unchanged — dispatcher code paths still need full delivery access.

## Capabilities

### New Capabilities
(none)

### Modified Capabilities
- `agent-delivery`: read-side validation now symmetric to write-side (`parseDeliveryRow` enforces variant required-field shape)
- `agent-registry`: `list_agents` response projects delivery to routing-safe subset, hiding transport-specific fields from peer agents

## Impact

- Code: `src/lib/delivery-spec.ts` (parseDeliveryRow); `src/mcp/tools.ts` (list_agents handler); possibly a new type in `src/storage/agents-repo.ts` or adjacent module for the public projection.
- Tests: `tests/delivery-spec.test.ts` (new corrupt-row cases); `tests/agents-repo-list-channel-session-id.test.ts` and any `list_agents` test (assert projected shape, assert absence of thread_id/ws_url/auth_token_ref).
- API: `list_agents` MCP response narrows — downstream consumers that depended on reading `thread_id`/`ws_url` from `list_agents` (none expected) would break. No documented caller; internal callers use the repo directly.
- Out of scope: W3 migration backfill gate (`needKind || needPayload`).
