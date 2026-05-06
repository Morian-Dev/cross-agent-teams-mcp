## MODIFIED Requirements

### Requirement: Within-session agent_id_collision via Authorization header

When a `register_agent` tool call carries an `Authorization` request header, the daemon MUST bind that session id to the sha256 hash of the (trimmed) header value on first binding, and MUST return `{ error: 'agent_id_collision' }` with HTTP status 409 on any subsequent `register_agent` for the **same MCP session id** presenting a different `Authorization` value.

When a `register_agent` call targets a `(team, name)` pair that is currently bound to a DIFFERENT MCP session id (a "cross-session re-claim"), the daemon MUST treat the new call as a TAKEOVER of that identity rather than a collision:

1. Update the in-memory connection binding for `(team, name)` to point to the new MCP session id.
2. Force-close the prior MCP transport associated with the old session id by invoking the SDK transport's `close()` method on it. The close MUST propagate through the transport's `onclose` chain so the prior session is removed from the daemon's `sessions` Map, its SSE fanout binding is detached, and its channel-wake binding (if any) is detached.
3. Proceed with the normal identity-reuse upsert path on the agents row (preserving `agent_id`, `registered_at`, `last_processed_event_id`; updating `last_seen_at`, `role`, `model`, etc.) and return `{ agent_id, team }` for the new session.
4. Log the takeover at debug level identifying the old session id, the new session id, and `(team, name)`. The log line MUST be emitted EVEN when the old session id is unknown to the transport (defensive-only path).

This collision protection is therefore now scoped to **within-session Authorization mismatch** only. Cross-session `register_agent` calls targeting the same `(team, name)` identity from a NEW MCP session id are ALWAYS legitimate takeover, regardless of whether the prior session is still alive in the `sessions` Map at the time of the takeover.

When the request carries no `Authorization` header (or an empty one after trim), the daemon MUST NOT enforce Authorization-based collision detection.

Arriving on a different TCP socket (e.g. after keep-alive expiry) MUST NOT by itself trigger a collision.

#### Scenario: Different Authorization credentials on same session id

- **GIVEN** session `sess-A` was first bound to the sha256 of `Authorization: Bearer tokenX`
- **WHEN** a request with `Mcp-Session-Id: sess-A` AND `Authorization: Bearer tokenY` calls `register_agent`
- **THEN** response is HTTP 409 with body `{ error: 'agent_id_collision' }`

#### Scenario: Cross-session same identity under different Authorization reuses agent_id

- **GIVEN** session `sess-A` has registered `(default, alice)` with `Authorization: Bearer tokenX`, then `sess-A` has been released (connection closed)
- **WHEN** session `sess-B` calls `register_agent` for `(default, alice)` with `Authorization: Bearer tokenY`
- **THEN** response is `{ agent_id: <the id from sess-A>, team: 'default' }` (reuse, not collision)

#### Scenario: Cross-session takeover while prior session is still live

- **GIVEN** session `sess-A` has called `register_agent` for `(default, alice)` and the daemon's `sessions` Map still contains `sess-A`
- **AND** `sess-A` has NOT sent DELETE and its MCP transport is still open
- **WHEN** a new MCP session `sess-B` calls `register_agent` for `(default, alice)` (no Authorization header on either call)
- **THEN** response is `{ agent_id: <the id from sess-A>, team: 'default' }` (200 OK, NOT 409)
- **AND** the daemon's in-memory connection binding for `('default', 'alice')` now points to `sess-B`
- **AND** the prior MCP transport for `sess-A` has been closed by the daemon
- **AND** `sess-A` no longer appears in the `sessions` Map

#### Scenario: Cross-session takeover emits a debug log

- **GIVEN** the conditions of the prior scenario hold
- **WHEN** the takeover is processed
- **THEN** the daemon emits a debug-level log line containing `takeover`, the old session id, the new session id, the team `'default'`, and the name `'alice'`
