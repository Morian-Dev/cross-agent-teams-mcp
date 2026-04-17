## MODIFIED Requirements

### Requirement: agent_id collision across sessions returns 409

When a `register_agent` tool call carries an `Authorization` request header, the daemon MUST bind that session id to the sha256 hash of the (trimmed) header value on first binding, and MUST return `{ error: 'agent_id_collision' }` with HTTP status 409 on any subsequent `register_agent` for the same session id presenting a different `Authorization` value.

When the request carries no `Authorization` header (or an empty one after trim), the daemon MUST NOT enforce collision detection against prior bindings for that session id; it trusts the `Mcp-Session-Id` header and allows the `register_agent` call.

In all modes, merely arriving on a different TCP socket (e.g. after HTTP keep-alive expiry) MUST NOT by itself trigger a collision.

#### Scenario: Different Authorization credentials on same session id

- **GIVEN** session `sess-A` was first bound to the sha256 of `Authorization: Bearer tokenX`
- **WHEN** a request with `Mcp-Session-Id: sess-A` AND `Authorization: Bearer tokenY` (a different value) calls `register_agent`
- **THEN** response is HTTP 409 with body `{ error: 'agent_id_collision' }`

#### Scenario: Same Authorization across different TCP sockets accepted

- **GIVEN** session `sess-A` was first bound to the sha256 of `Authorization: Bearer tokenX` from TCP connection C1
- **AND** the HTTP keep-alive timeout has expired so C1's underlying socket is closed
- **WHEN** the same MCP client re-sends `register_agent` with `Mcp-Session-Id: sess-A` AND `Authorization: Bearer tokenX` via a freshly-opened TCP connection C2
- **THEN** response is success (not HTTP 409); the registration metadata is upserted per the `Repeated register_agent within same session updates metadata` requirement

#### Scenario: Request without Authorization header never triggers agent_id_collision

- **GIVEN** session `sess-A` was registered previously (with or without an `Authorization` header on that prior request)
- **WHEN** a subsequent `register_agent` call arrives for `Mcp-Session-Id: sess-A` carrying no `Authorization` header (or an empty header after trim)
- **THEN** response is success (not HTTP 409); the daemon MUST NOT compare against any prior Authorization binding for this session
