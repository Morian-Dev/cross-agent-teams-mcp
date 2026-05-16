## ADDED Requirements

### Requirement: Boot-time drop of legacy task and contract tables

On daemon startup the schema bootstrap step SHALL execute `DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS contracts; DROP TABLE IF EXISTS contract_subscriptions;` once, after applying current-version `CREATE TABLE IF NOT EXISTS` statements.

The drop MUST be idempotent and silent: on fresh installs the statements are no-ops; on upgrades from a prior version they reclaim disk and remove the legacy tables. The drop MUST NOT log a warning or fail the boot if any of the tables are absent. After this step the schema MUST NOT contain `tasks`, `contracts`, or `contract_subscriptions` tables under any code path.

#### Scenario: Fresh install does not create legacy tables

- **GIVEN** an empty `data.db`
- **WHEN** the daemon boots
- **THEN** `PRAGMA table_info('tasks')`, `PRAGMA table_info('contracts')`, and `PRAGMA table_info('contract_subscriptions')` all return empty result sets
- **AND** the daemon completes startup without warnings

#### Scenario: Upgrade from prior version drops legacy tables

- **GIVEN** a `data.db` produced by a prior version that contains `tasks`, `contracts`, and `contract_subscriptions` tables with at least one row each
- **WHEN** the daemon boots on the new version
- **THEN** all three tables are absent from the database afterwards
- **AND** the daemon completes startup without warnings

## MODIFIED Requirements

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
