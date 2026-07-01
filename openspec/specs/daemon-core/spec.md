# daemon-core Specification

## Purpose

Run the agent-teams MCP daemon as a local-only HTTP service with lifecycle management (PID file, port fallback, graceful shutdown), optional bearer auth, consistent storage error mapping, and a health endpoint.
## Requirements
### Requirement: Daemon binds only to 127.0.0.1 by default and gates non-loopback binds on a bearer token

The daemon SHALL bind its HTTP listener to `127.0.0.1` by default. A `--host <addr>` flag SHALL allow binding to a different address (e.g. a LAN IP or `0.0.0.0`).

When the resolved bind address is not a loopback address, the daemon MUST require a non-empty `--token <t>` value (or the equivalent `CROSS_AGENT_TEAMS_MCP_TOKEN` environment variable). Without it, the daemon MUST refuse to start, write `token_required_for_non_loopback_bind` to stderr, and exit with a non-zero status. Loopback addresses are: any IPv4 address in `127.0.0.0/8`, the IPv6 address `::1`, and `::ffff:127.0.0.0/8`.

The legacy guarantee that loopback-only deployments need no token is preserved: when `--host` is omitted or resolves to a loopback address, `--token` remains optional.

#### Scenario: Default bind address still loopback

- **WHEN** the daemon is started with `npx cross-agent-teams-mcp daemon` without any host override
- **THEN** the HTTP server listens on `127.0.0.1:9100`
- **AND** the daemon starts even when `--token` is omitted

#### Scenario: Explicit loopback host with no token is accepted

- **WHEN** the daemon is started with `--host 127.0.0.1`
- **THEN** the daemon binds to `127.0.0.1:9100` and starts even when `--token` is omitted

#### Scenario: Non-loopback host without token refuses to start

- **WHEN** the daemon is started with `--host 0.0.0.0` and no `--token`
- **THEN** the daemon exits with a non-zero status
- **AND** stderr contains `token_required_for_non_loopback_bind`
- **AND** no port is bound

#### Scenario: Non-loopback host with token starts and binds the requested address

- **WHEN** the daemon is started with `--host 10.0.0.10 --token T`
- **THEN** the HTTP server listens on `10.0.0.10:9100`
- **AND** the startup log includes the bound host and port

#### Scenario: Token via env variable satisfies the non-loopback guard

- **GIVEN** the environment has `CROSS_AGENT_TEAMS_MCP_TOKEN=T`
- **WHEN** the daemon is started with `--host 0.0.0.0` and no `--token` flag
- **THEN** the daemon starts and binds the requested address
- **AND** stderr does NOT contain `token_required_for_non_loopback_bind`

### Requirement: Daemon accepts a device label via --device

The daemon SHALL accept an optional `--device <label>` flag that sets the local device label used to namespace this host's agents in the `agents` table.

When `--device` is omitted, the daemon SHALL derive the default value from `os.hostname()` by lowercasing and replacing any character outside `[a-z0-9_-]` with `-`. The result MUST be non-empty after derivation; if `os.hostname()` is empty or fully replaced, the daemon SHALL fall back to the literal `local`.

The resolved label MUST be non-empty, MUST NOT contain `:`, and MUST be 64 characters or fewer. If `--device` is supplied with a value violating these rules, the daemon SHALL refuse to start with stderr `invalid_device_label` and a non-zero exit status.

The resolved label is the authoritative local device identifier consumed by `agent-registry` (for `register_agent` device validation and for the startup migration's backfill).

#### Scenario: Default device label derived from hostname

- **GIVEN** `os.hostname()` returns `Host-A.local`
- **WHEN** the daemon is started without `--device`
- **THEN** the resolved local device label is `host-a.local`
- **AND** the startup log includes the resolved label

#### Scenario: Hostname containing disallowed characters is normalised

- **GIVEN** `os.hostname()` returns `Host@A`
- **WHEN** the daemon is started without `--device`
- **THEN** the resolved local device label is `host-a` (the `@` is replaced with `-`)

#### Scenario: --device flag overrides the derived default

- **WHEN** the daemon is started with `--device host-b`
- **THEN** the resolved local device label is `host-b`

#### Scenario: --device with colon is rejected

- **WHEN** the daemon is started with `--device has:colon`
- **THEN** the daemon exits with a non-zero status
- **AND** stderr contains `invalid_device_label`

#### Scenario: --device exceeding 64 characters is rejected

- **WHEN** the daemon is started with `--device <65-char string>`
- **THEN** the daemon exits with a non-zero status
- **AND** stderr contains `invalid_device_label`

#### Scenario: Empty hostname falls back to literal "local"

- **GIVEN** `os.hostname()` returns an empty string
- **WHEN** the daemon is started without `--device`
- **THEN** the resolved local device label is `local`

### Requirement: Loopback companion listener for non-loopback primary bind

When the daemon's primary listener is bound to a host that does NOT already cover IPv4 `127.0.0.1` (i.e. the host is not `127.0.0.1`, `localhost`, or `0.0.0.0`), `startServer` SHALL additionally bind a second `http.Server` on `127.0.0.1` at the same port that reuses the primary Fastify request handler. Same-host clients can then connect via `http://127.0.0.1:<port>/mcp` and be classified as `local` origin (which auto-fills the daemon's local device label and skips the remote-device spoofing check) without forcing operators to expose the daemon on every interface via `--host 0.0.0.0`.

The companion listener MUST be skipped when the primary host already covers `127.0.0.1` (matching any of `127.0.0.1`, `localhost`, `0.0.0.0`), because the OS already routes loopback traffic to the primary listener and a second bind would collide on the same port.

The companion behavior MUST be enabled by default and MUST be opt-out via the `--no-loopback-companion` flag (or `loopbackCompanion: false` on `StartOpts`).

Companion bind failure (e.g. port already held by another process on `127.0.0.1`) MUST be fatal: `startServer` MUST close the already-bound primary listener and throw `loopback_companion_bind_failed: <detail>`. Silently starting with only the primary listener would leave any local client configuration targeting `127.0.0.1:<port>` broken in a way that is hard to diagnose.

Lifecycle: the companion listener MUST be closed gracefully as part of the Fastify `onClose` hook chain so `app.close()` drains it alongside the primary listener. On shutdown-deadline expiry (see the `Graceful shutdown` requirement), the companion MUST be force-closed via `closeAllConnections()` alongside the primary, wired through `wireShutdown`'s `extraForceClose` hook.

#### Scenario: Companion bound when primary is non-loopback-covering

- **GIVEN** `startServer` is called with `host` set to a value that does not cover IPv4 loopback (for example, IPv6 loopback `::1` or a LAN IP like `192.168.1.5`)
- **AND** `loopbackCompanion` is left at its default
- **WHEN** primary bind succeeds on `<host>:<port>`
- **THEN** a second `http.Server` is also bound on `127.0.0.1:<port>` sharing the primary's request handler
- **AND** `startServer` returns with `loopbackCompanion` defined
- **AND** both `GET http://<host>:<port>/health` and `GET http://127.0.0.1:<port>/health` return `{ "ok": true }`

#### Scenario: Companion skipped when primary already covers 127.0.0.1

- **GIVEN** `startServer` is called with `host: '127.0.0.1'` (or `'localhost'` or `'0.0.0.0'`)
- **WHEN** startup completes
- **THEN** no second listener is created
- **AND** `loopbackCompanion` in the return value is `undefined`

#### Scenario: Companion disabled via opt-out

- **GIVEN** `startServer` is called with `host: '::1'` and `loopbackCompanion: false`
- **WHEN** startup completes
- **THEN** no companion listener is bound
- **AND** `loopbackCompanion` in the return value is `undefined`

#### Scenario: Companion bind failure is fatal

- **GIVEN** another process already holds `127.0.0.1:<port>`
- **AND** `startServer` is called with `host: '::1'` and `port: <port>` and the default companion enabled
- **WHEN** primary bind succeeds on `[::1]:<port>` but the companion bind on `127.0.0.1:<port>` fails with `EADDRINUSE`
- **THEN** `startServer` closes the primary listener
- **AND** rejects with an error whose message starts with `loopback_companion_bind_failed:`

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

The daemon SHALL write its process id to `~/.cross-agent-teams-mcp/daemon.pid` on startup (including the chosen port) and remove the file on graceful shutdown. If the file exists at startup and the referenced process is alive, the daemon MUST exit with error unless `--force` is passed.

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

The daemon SHALL handle `SIGTERM` and `SIGINT` by (a) stopping accept of new connections, (b) draining in-flight requests up to a configurable deadline (default `5000 ms`, overridable via the `XATS_SHUTDOWN_GRACE_MS` environment variable), (c) when the deadline expires, force-closing any remaining open sockets via the underlying HTTP server, (d) flushing the SQLite WAL checkpoint, (e) removing the pid file, and (f) exiting `0`. A second `SIGTERM` or `SIGINT` received before the first handler completes MUST skip the deadline, still remove the pid file, and exit `0` immediately.

#### Scenario: SIGTERM with no long-lived clients

- **GIVEN** a running daemon with no SSE / long-lived clients attached
- **WHEN** SIGTERM is sent
- **THEN** the daemon stops accepting new connections within 1 second
- **AND** the pid file is removed
- **AND** the daemon exits `0` well before the shutdown deadline

#### Scenario: SIGTERM with long-lived client still attached

- **GIVEN** a running daemon with at least one long-lived SSE / channel-proxy client holding an ESTABLISHED connection
- **WHEN** SIGTERM is sent
- **AND** the client does not voluntarily close its connection
- **THEN** the daemon stops accepting new connections immediately
- **AND** within `XATS_SHUTDOWN_GRACE_MS + 500 ms` of the signal, the daemon force-closes the remaining socket, removes the pid file, and exits `0`

#### Scenario: Second signal triggers fast exit

- **GIVEN** a running daemon that has already received SIGTERM and is mid-drain
- **WHEN** a second `SIGTERM` or `SIGINT` is sent
- **THEN** the daemon skips the remaining drain window
- **AND** removes the pid file
- **AND** exits `0` within 200 ms of the second signal

#### Scenario: XATS_SHUTDOWN_GRACE_MS=0 skips drain

- **GIVEN** a running daemon launched with `XATS_SHUTDOWN_GRACE_MS=0` in the environment
- **WHEN** SIGTERM is sent
- **THEN** the daemon force-closes any remaining sockets immediately without waiting
- **AND** removes the pid file
- **AND** exits `0`

### Requirement: Optional bearer token authentication

The daemon MAY be started with `--token <secret>`. When a token is configured, every MCP HTTP request MUST present it either via `Authorization: Bearer <secret>` header or a `token=<secret>` query string. Missing or mismatched tokens SHALL return HTTP 401.

The 401 response body MUST NOT be a bare `{ "error": <string> }` object. Strict MCP clients (e.g. codex's `rmcp`) deserialize any response body as a JSON-RPC message; a bare `{ "error": "invalid_token" }` object matches no JSON-RPC 2.0 variant and poisons the client transport (every subsequent call then fails with `Transport send error`). The body MUST be either an empty body (the safe default) or a well-formed JSON-RPC 2.0 error object `{ "jsonrpc": "2.0", "id": null, "error": { "code": <integer>, "message": <string> } }` that a strict client can deserialize without error. `WWW-Authenticate` MAY still be set as appropriate.

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
- **THEN** response status is 401
- **AND** the response body is NOT a bare `{ "error": "invalid_token" }` object (it is empty or a valid JSON-RPC 2.0 error object)

### Requirement: Storage unavailable error mapping

When any SQLite operation raises an error indicating I/O failure, WAL lock, or disk-full condition, the daemon MUST translate it to the tool response `{ "error": "storage_unavailable" }` and MUST NOT return a bare 500 with no body.

#### Scenario: SQLite raises disk-full during tool call

- **GIVEN** any MCP tool is being executed
- **WHEN** the underlying SQLite statement raises `SQLITE_FULL`
- **THEN** the tool response body contains `{ "error": "storage_unavailable" }`

### Requirement: Health endpoint

The daemon SHALL expose `GET /health` returning HTTP 200 with JSON body containing `{ "ok": true, "version": <package-version>, "uptime_seconds": <number>, "mcp_sessions": <metrics> }`. This endpoint MUST NOT require the bearer token even when auth is configured.

`mcp_sessions` MUST contain numeric fields:

- `total`: current MCP sessions retained by the daemon.
- `registered`: sessions that have completed `register_agent`.
- `orphan`: sessions that have not completed `register_agent`.
- `fanout`: active SSE fanout bindings.

#### Scenario: Health check without token

- **GIVEN** daemon started with `--token s3cret`
- **WHEN** a GET request is made to `/health` without Authorization header
- **THEN** response status is 200 and body has `ok: true`

#### Scenario: Health reports MCP session metrics

- **GIVEN** the daemon has one registered MCP session
- **AND** the daemon has one unregistered MCP session
- **WHEN** a GET request is made to `/health`
- **THEN** response body has `mcp_sessions.total: 2`
- **AND** response body has `mcp_sessions.registered: 1`
- **AND** response body has `mcp_sessions.orphan: 1`

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

### Requirement: Daemon MCP server identity

The daemon's `McpServer` instance SHALL declare its `name` field as `cross-agent-teams-mcp` during MCP initialize handshake.  This is the logical server identity reported to every connecting client and MUST NOT include legacy brand words.

#### Scenario: initialize serverInfo.name reports new brand

- **GIVEN** the daemon is running on a random port
- **WHEN** an MCP client completes the initialize handshake
- **THEN** the `serverInfo.name` field equals `cross-agent-teams-mcp`

### Requirement: Daemon source tree free of legacy brand word

The daemon's shipped source tree (non-archived, non-historical: `src/**`, `package.json`, `tsconfig.json`, active `docs/configs/**`, active `openspec/specs/**`, `opencode.json`, `.gitignore`) SHALL NOT contain `<legacy-brand>` as a literal substring, where `<legacy-brand>` denotes the 13-character ASCII case-sensitive string equal to `'ts'` concatenated with `'-agent-teams'`. This ensures the rename is complete and future readers never re-encounter the legacy brand.

Exempt paths: `openspec/changes/archive/**`, `discuss/**`, `node_modules/**`, `dist/**`, `pnpm-lock.yaml`, `worktrees/**`.

Additionally, documentation files that describe this invariant by negative assertion (notably `openspec/specs/daemon-core/spec.md` itself and the test files `tests/brand-sweep.test.ts`, `tests/daemon-brand-in-tool-text.test.ts`, `tests/proxy-cli.test.ts`, `tests/proxy-startup-notification.test.ts`) are CONDITIONALLY exempt: they MAY reference `<legacy-brand>` only as part of negative-assertion test data or placeholder-based prose, and they MUST be included in the brand-sweep test's `ANTI_BRAND_ASSERTION_EXCLUDES` allowlist (directly or via directory-level exclude).

#### Scenario: Brand-sweep grep returns zero matches

- **GIVEN** the ACTIVE_PATHS (as defined in `tests/brand-sweep.test.ts`) do not include files that carry `<legacy-brand>` as a non-exempt literal
- **AND** the allowlist excludes the negative-assertion documentation files and the daemon-core spec directory
- **WHEN** grep searches the ACTIVE_PATHS for `<legacy-brand>` with the allowlist excludes applied
- **THEN** grep exits with code `1` (no matches) or produces empty output

#### Scenario: Main daemon-core spec file is literal-free

- **GIVEN** `openspec/specs/daemon-core/spec.md` is the main-spec document describing this Requirement
- **WHEN** a consumer reads the file's raw bytes and searches for the `<legacy-brand>` literal as a contiguous substring
- **THEN** zero matches are found
- **AND** the Requirement's prose still unambiguously describes the forbidden string via the placeholder + constituent-parts lookup block at the top of the Requirement body

#### Scenario: Allowlist covers the main daemon-core spec file as defense in depth

- **GIVEN** `tests/brand-sweep.test.ts` defines `ANTI_BRAND_ASSERTION_EXCLUDES`
- **WHEN** the list is inspected
- **THEN** either `openspec/specs/daemon-core/` is covered via a directory-level exclude (e.g. `--exclude-dir=daemon-core` scoped inside `openspec/specs`) or the file is otherwise excluded by a path-aware entry
- **AND** this exclude does NOT silence any other spec under `openspec/specs/` that may legitimately require sweeping

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

