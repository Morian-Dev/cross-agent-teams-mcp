## ADDED Requirements

### Requirement: SSE fanout keyed by agent_id, attached after register_agent

The SSE fanout sink for an MCP session SHALL be attached to `SseFanout` keyed by the session's final `agent_id` (as returned by `register_agent`), **not** by the MCP session id. Attachment MUST be deferred until the first successful `register_agent` call on that session.

When `register_agent` succeeds and returns `agent_id=X`:

1. If another sink is currently attached under key `X` (e.g. from a prior session that reused the same identity), the transport MUST `fanout.detach(X)` on the old sink before attaching the new one.
2. The transport MUST call `fanout.attach(X, team, sink)` with `sink` bound to the current session's `StreamableHTTPServerTransport`.
3. The transport MUST update `agentIdHolder.current = X` so subsequent `from_agent_id` spoof checks compare against `X`.

When an MCP session closes (`transport.onclose`):

1. If the session had completed registration (i.e. `agentIdHolder.current` is set), the transport MUST `fanout.detach(agentIdHolder.current)`.
2. If the session closed before any successful `register_agent`, the transport MUST perform no fanout detach (there was nothing attached).

#### Scenario: Fanout attached after register_agent, not at session init

- **GIVEN** a freshly initialized MCP session with session id `sess-A` and no `register_agent` yet
- **WHEN** an internal caller inspects `SseFanout` state
- **THEN** no sink is attached under key `sess-A`
- **AND** no sink is attached under any key originating from this session

#### Scenario: Register triggers fanout attach under returned agent_id

- **GIVEN** a session `sess-A` that calls `register_agent` and receives `agent_id='X'`
- **WHEN** the tool call completes
- **THEN** `SseFanout` has exactly one sink attached under key `'X'`
- **AND** no sink is attached under key `sess-A`

#### Scenario: Cross-session reuse replaces prior sink

- **GIVEN** session `sess-A` registered `(default, alice, backend)` and holds the sink attached under `agent_id='X'`
- **WHEN** a new session `sess-B` registers the same identity and also receives `agent_id='X'`
- **THEN** the fanout sink for `X` is now `sess-B`'s transport
- **AND** `sess-A`'s old sink was detached before `sess-B`'s attach (net: exactly one sink under `X`)
- **AND** subsequent `fanout.emit('X', event)` reaches `sess-B`'s SSE stream, not `sess-A`'s

#### Scenario: Session close detaches the agent_id sink

- **GIVEN** session `sess-A` is registered and holds sink under `agent_id='X'`
- **WHEN** the HTTP transport emits `onclose`
- **THEN** `SseFanout` has no sink attached under `'X'`

#### Scenario: Close before register is a no-op for fanout

- **GIVEN** a session that initialized but never successfully called `register_agent`
- **WHEN** the HTTP transport emits `onclose`
- **THEN** the fanout state is unchanged (no spurious detach, no error)
