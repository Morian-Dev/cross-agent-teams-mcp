## Why

`SIGTERM` to the daemon currently closes the HTTP listener but never exits the process when channel proxies or Claude Code MCP sessions hold long-lived streams against it. The handler awaits `app.close()`, which itself waits for all in-flight requests to drain — and the long-lived streams never end on their own. The daemon ends up in a half-dead state (listener gone, process alive, ESTABLISHED sockets retained), forcing `kill -9` as the only escape.

## What Changes

- Bound `app.close()` with a deadline (default `5000 ms`, overridable via `XATS_SHUTDOWN_GRACE_MS`); on timeout, force-close remaining sockets and exit anyway.
- Force-close stragglers via `server.closeAllConnections()` (Node ≥ 18.2) inside the deadline branch so the process can exit cleanly even when long-lived clients refuse to disconnect.
- Treat a second `SIGTERM` / `SIGINT` as an instant exit: skip the deadline, still call `releasePidFile`, then `process.exit(0)`. Avoids leaving a stale pid file when the user gets impatient.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `daemon-core`: tighten the "Graceful shutdown" requirement to (a) bound the drain with a deadline, (b) force-close stragglers on timeout, (c) handle repeat signals as fast-exit.

## Impact

- `src/daemon/shutdown.ts` — rewrite the handler.
- `src/daemon/server.ts` (or wherever the underlying Node `http.Server` is reachable from Fastify) — expose the raw server to the shutdown handler so it can call `closeAllConnections()`.
- Tests: add a regression test covering "long-lived client attached → SIGTERM exits within deadline."
- No API / wire-protocol changes. No breaking changes for clients (existing long-lived streams will see a server-initiated close on shutdown, which they already need to handle on any daemon restart).
