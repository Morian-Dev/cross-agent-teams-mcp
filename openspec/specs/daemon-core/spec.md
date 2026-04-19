# daemon-core Specification

## Purpose

Run the agent-teams MCP daemon as a local-only HTTP service with lifecycle management (PID file, port fallback, graceful shutdown), optional bearer auth, consistent storage error mapping, and a health endpoint.
## Requirements
### Requirement: Daemon binds only to 127.0.0.1

The daemon SHALL bind its HTTP listener only to `127.0.0.1`. It MUST refuse any configuration that exposes the port on `0.0.0.0` or external interfaces.

#### Scenario: Default bind address

- **WHEN** the daemon is started with `npx ts-agent-teams daemon` without any host override
- **THEN** the HTTP server listens on `127.0.0.1:9100`
- **AND** a request from a non-loopback address (e.g. `192.168.x.x`) fails to connect

### Requirement: Port selection with fallback

The daemon SHALL attempt to bind the configured port (default `9100`). If the port is already in use, it MUST try `9101`, then `9102`. After three consecutive failures, it MUST exit with a non-zero status and print an explanatory message.

#### Scenario: First port free

- **WHEN** `9100` is free
- **THEN** daemon binds to `9100` and logs `listening on 127.0.0.1:9100`

#### Scenario: First two ports busy, third free

- **GIVEN** another process holds `9100` and `9101`
- **WHEN** daemon starts
- **THEN** it binds to `9102` and logs the chosen port

#### Scenario: All three candidate ports busy

- **GIVEN** `9100`, `9101`, `9102` are all held
- **WHEN** daemon starts
- **THEN** it exits with status code `1` and stderr contains `ports 9100-9102 unavailable`

### Requirement: PID file lifecycle

The daemon SHALL write its process id to `~/.ts-agent-teams/daemon.pid` on startup (including the chosen port) and remove the file on graceful shutdown. If the file exists at startup and the referenced process is alive, the daemon MUST exit with error unless `--force` is passed.

#### Scenario: Fresh startup writes pid file

- **WHEN** daemon starts and no `daemon.pid` exists
- **THEN** after startup the file contains the current pid and port

#### Scenario: Stale pid file (process dead)

- **GIVEN** `daemon.pid` exists but the recorded pid is not alive
- **WHEN** daemon starts
- **THEN** it overwrites the stale file and starts normally

#### Scenario: Live daemon already running

- **GIVEN** `daemon.pid` exists and the recorded pid is alive
- **WHEN** daemon starts without `--force`
- **THEN** it exits with status `1` and stderr contains `daemon already running`

### Requirement: Graceful shutdown

The daemon SHALL handle `SIGTERM` and `SIGINT` by (a) stopping accept of new connections, (b) flushing the SQLite WAL checkpoint, (c) closing all open SSE streams, and (d) removing the pid file before exiting `0`.

#### Scenario: SIGTERM triggers clean shutdown

- **GIVEN** a running daemon with one SSE client connected
- **WHEN** SIGTERM is sent
- **THEN** the SSE client receives a connection close
- **AND** the pid file is removed
- **AND** daemon exits `0`

### Requirement: Optional bearer token authentication

The daemon MAY be started with `--token <secret>`. When a token is configured, every MCP HTTP request MUST present it either via `Authorization: Bearer <secret>` header or a `token=<secret>` query string. Missing or mismatched tokens SHALL return HTTP 401 with body `{ "error": "invalid_token" }`.

#### Scenario: No token configured (default)

- **GIVEN** daemon started without `--token`
- **WHEN** client connects without any Authorization header
- **THEN** request is accepted

#### Scenario: Token configured and matches

- **GIVEN** daemon started with `--token s3cret`
- **WHEN** client sends `Authorization: Bearer s3cret`
- **THEN** request is accepted

#### Scenario: Token configured and mismatch

- **GIVEN** daemon started with `--token s3cret`
- **WHEN** client sends `Authorization: Bearer wrong`
- **THEN** response status is 401 and body is `{ "error": "invalid_token" }`

### Requirement: Storage unavailable error mapping

When any SQLite operation raises an error indicating I/O failure, WAL lock, or disk-full condition, the daemon MUST translate it to the tool response `{ "error": "storage_unavailable" }` and MUST NOT return a bare 500 with no body.

#### Scenario: SQLite raises disk-full during tool call

- **GIVEN** any MCP tool is being executed
- **WHEN** the underlying SQLite statement raises `SQLITE_FULL`
- **THEN** the tool response body contains `{ "error": "storage_unavailable" }`

### Requirement: Health endpoint

The daemon SHALL expose `GET /health` returning HTTP 200 with JSON body `{ "ok": true, "version": <package-version>, "uptime_seconds": <number> }`. This endpoint MUST NOT require the bearer token even when auth is configured.

#### Scenario: Health check without token

- **GIVEN** daemon started with `--token s3cret`
- **WHEN** a GET request is made to `/health` without Authorization header
- **THEN** response status is 200 and body has `ok: true`

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

