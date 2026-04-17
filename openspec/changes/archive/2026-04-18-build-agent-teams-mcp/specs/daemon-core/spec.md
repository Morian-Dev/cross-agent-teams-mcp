## ADDED Requirements

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
