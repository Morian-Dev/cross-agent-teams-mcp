## ADDED Requirements

### Requirement: Orphan session garbage collection

The daemon SHALL run a periodic ticker that walks the in-memory `sessions` Map maintained by `mountMcp` and force-closes any session whose `agentIdHolder.current` is still `undefined` more than 60 seconds after the session's `onsessioninitialized` callback fired.

A session is "orphan" if and only if BOTH:

1. `agentIdHolder.current === undefined` (no successful `register_agent` has bound an agent_id to the session yet), AND
2. `Date.now() - session.createdAt >= 60_000` (created at least 60 seconds ago, where `createdAt` is recorded synchronously inside `onsessioninitialized`).

Force-closing an orphan session MUST invoke `session.transport.close()`. Closing the transport MUST propagate to the existing `onclose` chain so the session is removed from `sessions` Map, the SSE fanout binding is detached (if any), the channel-wake fanout binding is detached (if any), and the `sessionOwners` Authorization-hash binding is removed.

Sessions whose `agentIdHolder.current` is set (i.e. that have completed at least one successful `register_agent`) MUST NEVER be touched by this GC, regardless of how long they have been idle. Long-idle user-facing sessions (Claude Code, Codex, opencode primary clients) are intentionally exempt from time-based reaping.

The GC tick interval MUST be at least 30 seconds (long enough that the GC itself does not contribute meaningful CPU pressure even with thousands of orphans). The default tick interval SHALL be 60 seconds.

The GC ticker MUST be cleared when the Fastify app emits `onClose`, alongside the existing cleanup ticker registered in `buildServer`.

The GC MUST emit a debug-level log line for each orphan it reaps, including the orphan's MCP session id and the age in seconds at reap time.

#### Scenario: Orphan session past grace is reaped

- **GIVEN** an MCP client opens a connection and the daemon assigns session `sess-X`
- **AND** the client never calls `register_agent` (or its `register_agent` call returned an error before binding agent_id)
- **AND** the GC tick fires more than 60 seconds after `sess-X` was created
- **WHEN** the GC walks the sessions Map
- **THEN** `sess-X` is force-closed (its transport's `close()` method invoked)
- **AND** `sess-X` is removed from the `sessions` Map after the onclose chain settles

#### Scenario: Registered session is exempt from GC

- **GIVEN** session `sess-Y` called `register_agent` successfully one second after `initialize` 24 hours ago
- **AND** no further activity has occurred on `sess-Y` since then
- **WHEN** the GC tick fires
- **THEN** `sess-Y` is NOT force-closed
- **AND** `sess-Y` remains in the `sessions` Map

#### Scenario: Orphan session within grace is not yet reaped

- **GIVEN** session `sess-Z` was created 10 seconds ago
- **AND** `sess-Z`'s `agentIdHolder.current` is `undefined`
- **WHEN** the GC tick fires
- **THEN** `sess-Z` is NOT force-closed
- **AND** `sess-Z` remains in the `sessions` Map

#### Scenario: Reap propagates to fanout and channel bindings

- **GIVEN** an orphan session `sess-O` had registered an SSE fanout sink (e.g. via a half-completed registration path that bound the sink before failing) and a channel-wake sink
- **WHEN** the GC reaps `sess-O`
- **THEN** the SSE fanout no longer holds a sink for `sess-O`
- **AND** the channel-wake fanout no longer holds a sink for `sess-O`'s session id
