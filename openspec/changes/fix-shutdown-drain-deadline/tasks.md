## 1. Refactor shutdown handler

- [x] 1.1 Rewrite `src/daemon/shutdown.ts` to read `XATS_SHUTDOWN_GRACE_MS` (default `5000`, parse-int safe, clamp negatives to `0`)
- [x] 1.2 Replace `process.once(SIGTERM, ...)` / `process.once(SIGINT, ...)` with `process.on(...)` plus a module-local `shuttingDown` flag
- [x] 1.3 First-signal path: race `app.close()` against `setTimeout(graceMs)`; on timeout call `app.server.closeAllConnections()`, then `releasePidFile`, then `process.exit(0)`
- [x] 1.4 Second-signal path: skip the race, immediately `releasePidFile` and `process.exit(0)`
- [x] 1.5 Export an injectable `opts.exit` and `opts.graceMs` for tests; keep current signature backward compatible (`wireShutdown(app, pidPath)` still works)

## 2. Tests

- [x] 2.1 Add `tests/shutdown-drain-deadline.test.ts`: spin up real daemon, attach a long-lived `GET /mcp` SSE-style stream, send SIGTERM, assert process exits within `graceMs + 500 ms`
- [x] 2.2 Add scenario: no long-lived clients → process exits within 1 second
- [x] 2.3 Add scenario: second SIGTERM during drain → exit within 200 ms of second signal
- [x] 2.4 Add scenario: `XATS_SHUTDOWN_GRACE_MS=0` → immediate force-close
- [x] 2.5 Verify pid file removed in every scenario

## 3. Docs

- [x] 3.1 Document `XATS_SHUTDOWN_GRACE_MS` in `docs/configs/README.md` alongside `KEEP_ALIVE_TIMEOUT_MS`
- [x] 3.2 Update CHANGELOG with the behavior change (drain now bounded, second-signal fast exit)
