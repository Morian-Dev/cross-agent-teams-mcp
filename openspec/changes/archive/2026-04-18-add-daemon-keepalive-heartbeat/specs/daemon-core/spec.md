## ADDED Requirements

### Requirement: HTTP keep-alive timeout default and env override

The daemon MUST configure Fastify's underlying HTTP server with an explicit `keepAliveTimeout` setting.  The default value MUST be 120000 milliseconds (120 seconds).  If the environment variable `KEEP_ALIVE_TIMEOUT_MS` is present and parses as a positive integer, that value MUST be used instead.  The daemon MUST also set `headersTimeout = keepAliveTimeout + 1000` to satisfy Node's invariant that headersTimeout exceeds keepAliveTimeout.

#### Scenario: Default keep-alive timeout when no env var

- **GIVEN** `KEEP_ALIVE_TIMEOUT_MS` is not set (or empty / non-numeric)
- **WHEN** the daemon boots via `startServer(...)`
- **THEN** the Fastify server's `keepAliveTimeout` property is `120000`
- **AND** the server's `headersTimeout` property is `121000`

#### Scenario: Env override applies at boot

- **GIVEN** `process.env.KEEP_ALIVE_TIMEOUT_MS = '60000'`
- **WHEN** the daemon boots
- **THEN** the Fastify server's `keepAliveTimeout` is `60000`
- **AND** `headersTimeout` is `61000`

#### Scenario: Invalid env value falls back to default

- **GIVEN** `process.env.KEEP_ALIVE_TIMEOUT_MS = 'not-a-number'`
- **WHEN** the daemon boots
- **THEN** `keepAliveTimeout` is `120000` (default)
- **AND** the daemon does not crash at startup

### Requirement: SSE heartbeat ticker on attached sinks

The `SseFanout` MUST start an interval timer when the first sink attaches, and MUST stop that timer when the last sink detaches.  While at least one sink is attached, the timer MUST fire every `HEARTBEAT_INTERVAL_MS` milliseconds (default 30000, env-override same name) and, on each tick, invoke `sendHeartbeat()` on every currently-attached sink.

`SseSink.sendHeartbeat()` MUST transmit a JSON-RPC notification `{ jsonrpc: '2.0', method: 'notifications/heartbeat', params: {} }` over the MCP transport.  A failure in the underlying transport (e.g. no active GET stream) MUST be swallowed — the heartbeat is best-effort.

The heartbeat timer MUST be cleared when the daemon shuts down (onClose hook) so test harnesses don't leak timers.

#### Scenario: First attach starts the ticker

- **GIVEN** a fresh `SseFanout` with no attached sinks
- **WHEN** `fanout.attach('sess-A', 'default', sink)` is called
- **THEN** an interval timer is active (via `setInterval`)
- **AND** subsequent ticks call `sink.sendHeartbeat()`

#### Scenario: Last detach stops the ticker

- **GIVEN** a fanout with one attached sink
- **WHEN** `fanout.detach('sess-A')` is called (no other sinks attached)
- **THEN** the interval timer is cleared (no further `sendHeartbeat` calls occur)

#### Scenario: Heartbeat delivered at configured interval

- **GIVEN** `SseFanout` initialized with `heartbeatIntervalMs: 100`
- **AND** one attached sink whose `sendHeartbeat` is a vi.fn spy
- **WHEN** 250 ms pass
- **THEN** the spy is called at least twice (2 ticks at 100 ms + some jitter)

#### Scenario: MCP client receives notifications/heartbeat

- **GIVEN** a daemon configured with `HEARTBEAT_INTERVAL_MS=100`
- **AND** an MCP SDK client connected via Streamable HTTP that has registered a notification handler for method `notifications/heartbeat`
- **WHEN** the client waits 400 ms on its event loop
- **THEN** it receives at least one `notifications/heartbeat` notification with empty (or null) params

#### Scenario: Heartbeat does not interfere with contract_event delivery

- **GIVEN** a fanout with an attached sink subscribed to contract `X`
- **WHEN** `fanout.emitContractEvent(...)` fires during a heartbeat tick window
- **THEN** the contract_event notification is still delivered to the subscriber
- **AND** the heartbeat does not consume or replace it
