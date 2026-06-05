## ADDED Requirements

### Requirement: MCP session is tagged with origin and peer address

For every MCP HTTP request, the daemon SHALL classify the connecting peer as `origin: 'local' | 'remote'` based on the socket's remote address:

- `local`: the socket's `remoteAddress` belongs to a loopback range — IPv4 `127.0.0.0/8`, IPv6 `::1`, or `::ffff:127.0.0.0/8`. Unix-domain sockets (if ever used) are treated as `local`.
- `remote`: any other address.

When the request belongs to an MCP session identified by `Mcp-Session-Id`, the daemon SHALL stash `{ origin, remote_addr }` on the in-memory session record. The `remote_addr` value is the raw socket remote address string for `remote` sessions, and `null` for `local` sessions. The tagging happens at the transport layer (e.g. a Fastify `onRequest` hook) BEFORE any tool dispatch and MUST be available to tool handlers invoked on that session.

The session tag is daemon-internal: it MUST NOT appear in any tool response payload, MUST NOT appear in `list_agents` output, and MUST NOT be exposed through any introspection tool. It is consumed only by:

- `register_agent` (in `agent-registry`) — to enforce device-spoofing guards and to write `remote_addr` on the agent row for non-loopback registrations.
- Daemon-internal audit logging at debug level.

#### Scenario: Loopback session is tagged local

- **GIVEN** an MCP client connects from `127.0.0.1` and obtains a session id
- **WHEN** any tool is dispatched on that session
- **THEN** the daemon's session record for that session id has `origin = 'local'` and `remote_addr = null`

#### Scenario: Non-loopback session is tagged remote with peer address

- **GIVEN** the daemon is bound to `0.0.0.0:9100` with a token
- **WHEN** an MCP client connects from `10.0.0.42` and obtains a session id
- **THEN** the daemon's session record for that session id has `origin = 'remote'` and `remote_addr = '10.0.0.42'`

#### Scenario: IPv6 loopback ::1 is tagged local

- **GIVEN** an MCP client connects from `::1` and obtains a session id
- **THEN** the session record has `origin = 'local'`

#### Scenario: IPv4-mapped IPv6 loopback is tagged local

- **GIVEN** an MCP client connects from `::ffff:127.0.0.1` and obtains a session id
- **THEN** the session record has `origin = 'local'`

#### Scenario: origin and remote_addr are NOT returned by list_agents

- **GIVEN** agents exist in the caller's team registered from both loopback and remote sessions
- **WHEN** the caller invokes `list_agents()`
- **THEN** no entry in the `agents[]` response array contains a key named `origin`
- **AND** no entry contains a key named `remote_addr`
