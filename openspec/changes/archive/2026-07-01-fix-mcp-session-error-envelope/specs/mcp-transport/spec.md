## MODIFIED Requirements

### Requirement: Session id assignment

The transport SHALL assign a unique session id (UUID v4) to every new MCP HTTP session and surface it via the `Mcp-Session-Id` response header. Subsequent requests from the same client MUST include that header.

When a request (POST, GET, or DELETE on `/mcp`) presents an `Mcp-Session-Id` that the daemon does not currently hold (never issued, or already reaped/closed), the daemon MUST reject it with **HTTP 404**. This aligns with the MCP Streamable HTTP transport spec: a `404` in response to a request carrying a session id is the standard signal for the client to start a new session by re-sending `initialize` WITHOUT a session id. The guarantee this requirement establishes is that the rejection MUST NOT poison a strict client's transport (see the body rule below); whether a specific client transparently re-initializes AND retries the in-flight request on receiving the `404` is client-side behavior and is NOT asserted by this requirement.

The response body for this rejection MUST NOT be a bare `{ "error": <string> }` object. Strict MCP clients deserialize ANY response body as a JSON-RPC message; a bare `{ "error": ... }` object matches no JSON-RPC 2.0 variant and poisons the client's transport worker (observed symptom: `Deserialize error: data did not match any variant of untagged enum JsonRpcMessage`, after which every subsequent tool call fails with `Transport send error`). The body MUST therefore be either:

- an empty body (the safe default), or
- a well-formed JSON-RPC 2.0 error object `{ "jsonrpc": "2.0", "id": null, "error": { "code": <integer>, "message": <string> } }` that a strict client can deserialize without error.

The chosen form MUST be verified against a strict `rmcp`-based client (see design). A request that fails session lookup MUST NOT bump any session timestamp.

#### Scenario: Two clients receive distinct session ids

- **WHEN** two independent MCP clients call `initialize`
- **THEN** each receives a different `Mcp-Session-Id` header value

#### Scenario: Follow-up request with unknown session id

- **WHEN** a client sends a tool call with `Mcp-Session-Id: <random-uuid-never-issued>`
- **THEN** response status is `404`
- **AND** the response body is NOT a bare `{ "error": "unknown_session" }` object (it is empty or a valid JSON-RPC 2.0 error object)

#### Scenario: Reaped-session request is not transport-poisoning and a fresh initialize is accepted

- **GIVEN** an MCP session id that was force-closed by orphan GC
- **WHEN** a client issues a request reusing that now-unknown session id
- **THEN** the daemon returns `404` with a non-poisoning body (no bare `{ "error": ... }` object)
- **AND** a subsequent `initialize` sent WITHOUT a session id succeeds and yields a fresh `Mcp-Session-Id` (the daemon does not carry over any poisoned state)

### Requirement: Orphan session garbage collection

The daemon SHALL run a periodic ticker that walks the in-memory `sessions` Map maintained by `mountMcp` and force-closes unregistered sessions that exceed the configured idle window, max-age window, or unregistered-session count limit. The daemon MUST also enforce the unregistered-session count limit immediately after a new MCP session is initialized.

Each session MUST track a `lastActivityAt` timestamp. `lastActivityAt` MUST be initialized to the value of `createdAt` inside `onsessioninitialized`, and MUST be set to `Date.now()` whenever a POST, GET, or DELETE request matches that session (i.e. on every successful transport-level interaction). Requests that fail session lookup with the unknown-session rejection MUST NOT bump any timestamp.

A session is "orphan" if and only if:

1. `agentIdHolder.current === undefined` (no successful `register_agent` has bound an agent_id to the session yet).

Orphan-session reaping is **idle-based and cap-based**. An orphan session MUST be reaped when either of these conditions is true:

1. `Date.now() - session.lastActivityAt >= idleMs` (no transport-level client activity within the idle grace window). An orphan whose `lastActivityAt` was bumped by a client POST/GET/DELETE within the last `idleMs` is therefore NOT reaped by this rule: an actively-transacting but not-yet-registered client (for example a codex session mid-setup or immediately after `compact`) is treated as a live client, not a zombie. Zombie sessions that only hold a server→client stream open never bump `lastActivityAt` (heartbeats are server→client and do not count as activity), so they still fall to this idle reap.
2. The number of orphan sessions exceeds `maxSessions`; the daemon MUST reap the oldest orphan sessions first until the number of remaining orphans is at most `maxSessions`. This cap applies regardless of recent activity, so it still bounds the total number of unregistered sessions.

Max-age is NOT an independent reap trigger. Once an orphan with recent client activity is exempt from age-based reaping, a max-age rule would only ever fire on sessions the idle rule already reaps (its condition is a strict subset of the idle rule), so it is redundant and MUST NOT be encoded as a live, separately-reachable branch.

The default idle window SHALL be `300_000 ms` (5 minutes). The default MUST be overridable via the `ORPHAN_GC_IDLE_MS` environment variable or the `orphanGcIdleMs` `ServerOpts` field, both of which accept a positive integer (millisecond) value.

The `ORPHAN_GC_MAX_AGE_MS` environment variable and the `orphanGcMaxAgeMs` `ServerOpts` field MUST still be accepted (a positive integer millisecond value) so existing configuration does not error, but they are now **inert**: no reap decision depends on a max-age window. They are retained only for backward compatibility.

The default orphan-session limit SHALL be `500`. The default MUST be overridable via the `ORPHAN_GC_MAX_SESSIONS` environment variable or the `orphanGcMaxSessions` `ServerOpts` field, both of which accept a positive integer value.

Force-closing an orphan session MUST invoke `session.transport.close()`. Closing the transport MUST propagate to the existing `onclose` chain so the session is removed from `sessions` Map, the SSE fanout binding is detached (if any), the channel-wake fanout binding is detached (if any), and the `sessionOwners` Authorization-hash binding is removed.

Sessions whose `agentIdHolder.current` is set (i.e. that have completed at least one successful `register_agent`) MUST NEVER be touched by this GC, regardless of how long they have been idle.

The GC tick interval MUST be at least 30 seconds (long enough that the GC itself does not contribute meaningful CPU pressure even with thousands of orphans). The default tick interval SHALL be 60 seconds.

The GC ticker MUST be cleared when the Fastify app emits `onClose`, alongside the existing cleanup ticker registered in `buildServer`.

The GC MUST NOT emit orphan-reap log lines by default. When an explicit MCP transport logger is configured by the embedding daemon or test harness, the GC MAY emit a debug-level log line for each orphan it reaps, including the orphan's MCP session id, age in seconds, idle duration in seconds, and reap reason.

#### Scenario: Orphan session past idle grace is reaped

- **GIVEN** an MCP client opens a connection and the daemon assigns session `sess-X`
- **AND** the client never calls `register_agent` and issues no further transport-level requests
- **AND** the GC tick fires more than `idleMs` after `sess-X`'s `lastActivityAt`
- **WHEN** the GC walks the sessions Map
- **THEN** `sess-X` is force-closed (its transport's `close()` method invoked)
- **AND** `sess-X` is removed from the `sessions` Map after the onclose chain settles

#### Scenario: Activity bumps the idle clock and prevents reap

- **GIVEN** session `sess-W` was created and `agentIdHolder.current` is still `undefined`
- **AND** the client issues any matching POST/GET/DELETE on `sess-W` (e.g. a tool call) shortly before the GC tick
- **AND** the orphan count is at or below `maxSessions`
- **WHEN** the GC tick fires within `idleMs` of that activity
- **THEN** `sess-W` is NOT force-closed
- **AND** `sess-W` remains in the `sessions` Map

#### Scenario: Active orphan past max age is NOT reaped

- **GIVEN** session `sess-A` was created more than `maxAgeMs` ago
- **AND** `sess-A` has not completed `register_agent`
- **AND** the client recently issued a matching POST/GET/DELETE so `sess-A` is still within `idleMs` of activity
- **WHEN** the GC tick fires
- **THEN** `sess-A` is NOT force-closed (recent client activity keeps it within the idle window, and there is no independent max-age reap)
- **AND** `sess-A` remains in the `sessions` Map

#### Scenario: Idle orphan past max age is reaped

- **GIVEN** session `sess-B` was created more than `maxAgeMs` ago
- **AND** `sess-B` has not completed `register_agent`
- **AND** `sess-B` has had no client transport activity within `idleMs`
- **WHEN** the GC tick fires
- **THEN** `sess-B` is force-closed by the idle rule
- **AND** no console output is emitted unless an explicit MCP transport logger was configured

#### Scenario: Orphan cap reaps oldest unregistered sessions only

- **GIVEN** the daemon has more than `maxSessions` orphan sessions
- **AND** it also has registered sessions that may be long idle
- **WHEN** the GC tick fires
- **THEN** the daemon force-closes the oldest orphan sessions until at most `maxSessions` orphans remain
- **AND** registered sessions are not force-closed by this cap
- **AND** an active orphan may still be reaped by this cap despite recent activity

#### Scenario: New orphan creation enforces cap immediately

- **GIVEN** the daemon already has `maxSessions` orphan sessions
- **WHEN** a new MCP session is initialized and remains unregistered
- **THEN** the daemon force-closes the oldest orphan session without waiting for the next GC tick
- **AND** the newly initialized session remains available

#### Scenario: Registered session is exempt from GC

- **GIVEN** session `sess-Y` called `register_agent` successfully one second after `initialize` 24 hours ago
- **AND** no further activity has occurred on `sess-Y` since then
- **WHEN** the GC tick fires
- **THEN** `sess-Y` is NOT force-closed
- **AND** `sess-Y` remains in the `sessions` Map

#### Scenario: Orphan session within grace is not yet reaped

- **GIVEN** session `sess-Z` was created 10 seconds ago with no subsequent activity
- **AND** `sess-Z`'s `agentIdHolder.current` is `undefined`
- **AND** the orphan count is at or below `maxSessions`
- **WHEN** the GC tick fires with the default 5-minute grace
- **THEN** `sess-Z` is NOT force-closed
- **AND** `sess-Z` remains in the `sessions` Map

#### Scenario: Reap propagates to fanout and channel bindings

- **GIVEN** an orphan session `sess-O` had registered an SSE fanout sink (e.g. via a half-completed registration path that bound the sink before failing) and a channel-wake sink
- **WHEN** the GC reaps `sess-O`
- **THEN** the SSE fanout no longer holds a sink for `sess-O`
- **AND** the channel-wake fanout no longer holds a sink for `sess-O`'s session id
