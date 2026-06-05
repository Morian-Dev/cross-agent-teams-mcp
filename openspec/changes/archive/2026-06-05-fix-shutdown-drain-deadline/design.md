## Context

Today's handler in `src/daemon/shutdown.ts`:

```ts
const handler = async (_signal: NodeJS.Signals) => {
  try { await app.close() } catch { /* ignore */ }
  releasePidFile(pidPath)
  process.exit(0)
}
process.once('SIGTERM', handler)
process.once('SIGINT', handler)
```

Fastify's `app.close()` returns only after every in-flight request resolves. Two client classes never end their request on their own:

1. **`cross-agent-teams-channel` proxy** — holds a long-lived `GET /mcp` SSE stream for poke delivery.
2. **Claude Code MCP sessions** — Streamable-HTTP transport keeps a GET stream open whenever the host has subscribed to notifications.

Under typical jt-on-laptop conditions there are ~4 such sockets pinned to the daemon. SIGTERM thus closes the listener (good — it's the first thing Fastify does in `close()`) but the awaiting Promise never resolves, so `process.exit(0)` never runs. The user is left with a half-dead daemon and `kill -9` as the only out.

Raw `http.Server` is reachable as `app.server` (already used in `src/daemon/server.ts` for `headersTimeout` and `address()`). Node ≥ 18.2 exposes `server.closeAllConnections()` for forced socket termination.

## Goals / Non-Goals

**Goals:**
- SIGTERM exits the daemon within a bounded time even with long-lived clients attached.
- Pid file is always released, regardless of exit path.
- Force-exit on a second SIGTERM / SIGINT, for impatient users.
- Existing clean-path behavior unchanged when no long-lived clients remain.

**Non-Goals:**
- No protocol-level "server closing soon" notification to clients (they already handle reconnects on transport errors).
- Not switching to a different graceful-shutdown library; minimal patch to existing handler.
- Not introducing draining for individual MCP sessions (transport-layer close is enough).

## Decisions

### D1: Deadline-bound `app.close()`, configurable via env

`app.close()` is wrapped with a `Promise.race([..., setTimeout(graceMs)])`. `graceMs` defaults to `5000`, overridable via `XATS_SHUTDOWN_GRACE_MS`.

- **Alternative considered**: `pkg/fastify-graceful-shutdown` — extra dependency, more behavior than we need.
- **Alternative considered**: send protocol-level "closing" notifications to MCP clients first — clients are already resilient to abrupt disconnect; adds complexity for no observable user benefit.

### D2: `server.closeAllConnections()` on timeout

When the deadline fires, call `app.server.closeAllConnections()` to terminate remaining sockets, then call `process.exit(0)`. Node ≥ 18.2 guarantees this method exists; `package.json` already requires `"node": ">=20"`, so no version guard needed.

### D3: Second signal == fast-exit

The current `process.once(...)` registration makes a second SIGTERM/SIGINT fall through to Node's default handler, which (a) exits with code `143`/`130`, not `0`, and (b) skips `releasePidFile`. We replace `once` with `on`, and use a module-level `shuttingDown` flag: first signal starts the deadline path, second signal calls `releasePidFile` and `process.exit(0)` immediately.

### D4: Keep the handler in `shutdown.ts`, accept raw server as a parameter

`wireShutdown(app, pidPath)` becomes `wireShutdown(app, pidPath, opts?)` where `opts.graceMs` and `opts.exit` are injectable for tests. The handler reaches the raw server through `app.server` (already public Fastify API).

## Risks / Trade-offs

- **Risk**: `closeAllConnections()` aborts mid-write responses, clients may see partial bodies on shutdown → **Mitigation**: only triggers after the 5 s drain expires; well-behaved clients should have finished by then. Long-lived streams are designed to handle abrupt disconnect.
- **Risk**: `XATS_SHUTDOWN_GRACE_MS=0` would skip the drain entirely → acceptable; explicit user opt-in, documented as a tool for restart scripts.
- **Trade-off**: SIGTERM no longer means "drain forever, never lose work" — it now means "drain up to N ms then force exit". For this daemon (in-memory MCP transport, durable state in SQLite), forced socket close is safe; nothing useful is being lost.
