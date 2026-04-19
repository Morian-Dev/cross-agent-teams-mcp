# Design — add-daemon-keepalive-heartbeat

## Context

`src/daemon/server.ts` builds Fastify with `Fastify({ logger: false })` — zero HTTP-level tuning.  Node's default `server.keepAliveTimeout` is 5 seconds, which Fastify inherits.  `src/daemon/sse-fanout.ts` has no heartbeat mechanism — SSE long connections are maintained purely by TCP keepalive default (which varies by OS, often 2h, useless for NAT idle timeouts of 30-60s).

2026-04-18 实测: codex idle 数十秒再发 MCP tool call 时 rmcp decode 崩.  最符合症状的根因是: rmcp HTTP connection pool 持有 stale socket — Fastify 5s 后主动断, rmcp 未感知, 下次复用时 partial read → decode error.

## Goals

1. Keep HTTP short connections alive for a reasonable idle window (default 120s) so rmcp / undici / node-fetch style connection pools don't meet stale sockets inside the common "user returns to agent" window.
2. Keep SSE long connections (GET /mcp) TCP-active via application-level heartbeat, so NAT / stateful firewall / OS idle timers don't kill them.
3. Make both intervals env-configurable for lower-latency tests and ops tuning.
4. Don't promise to fix codex.  The root bug is in codex's rmcp client lacking retry-on-decode-error; we can only widen the window.

## Non-Goals

- **Don't** add any protocol-level retry logic to daemon (MCP server side doesn't have the session's history to meaningfully retry).
- **Don't** modify codex / opencode / Claude Code client config.
- **Don't** do TCP-level keepalive (`socket.setKeepAlive(true, ms)`).  Node HTTP server doesn't expose per-connection TCP keepalive cleanly; application-level heartbeat + keep-alive timeout extension is the idiomatic path.
- **Don't** gate heartbeat on SSE stream state — just fire it unconditionally; the SDK's `transport.send()` already catches "no active GET stream yet" errors and drops silently.

## Key Decisions

### 1. Heartbeat carried as `notifications/heartbeat` JSON-RPC notification

**Decision**: use `{ jsonrpc: '2.0', method: 'notifications/heartbeat', params: {} }`.  No notification id (notification don't expect responses per JSON-RPC).

**Rationale**:
- MCP spec: clients MUST tolerate unknown notification methods by dropping silently.  All three known clients (Claude Code / opencode / codex rmcp) follow this.
- Sticking with JSON-RPC gives us a structured way to version / extend later (e.g. add `params: { server_time }`).
- `notifications/contract_event` is reserved for contract deltas; reusing it for heartbeats would confuse subscribers.

**Rejected**:
- Raw SSE comment (`:heartbeat\n\n`): would require bypassing `StreamableHTTPServerTransport.send()` and writing to the raw `reply.raw` socket.  Tight coupling to SDK internals.
- `notifications/progress` with fake progress: misuses a standardized notification, breaks semantic contract with MCP clients that do interpret progress.

### 2. Heartbeat interval 30s default, ENV `HEARTBEAT_INTERVAL_MS` override

**Rationale**:
- Common NAT / firewall state tables expire at 60-120s idle; 30s heartbeat keeps us at 50% safety margin.
- SSE convention in the wild (GitHub, Heroku, etc.) is 15-30s.  30s chosen to keep traffic minimal.
- Tests use `HEARTBEAT_INTERVAL_MS=100` for millisecond-level assertions without waiting seconds.

### 3. Fastify `keepAliveTimeout` 120s default, ENV `KEEP_ALIVE_TIMEOUT_MS` override

**Rationale**:
- Node default 5s is optimized for HTTP/1.0 with short keep-alive windows; unrealistic for modern client pools.
- 120s chosen as "long enough for any human coming back from a meeting / break", short enough not to hoard connection slots on a shared port.
- Also set `server.headersTimeout` to `keepAliveTimeout + 1000` (Node requirement: headersTimeout > keepAliveTimeout to avoid a race warning).
- Tests can use `KEEP_ALIVE_TIMEOUT_MS=60000` if needed, or accept the 120s default (it's only a server-side parameter, doesn't make tests slow).

### 4. Heartbeat ticker lives on `SseFanout`

**Decision**: `SseFanout` constructor accepts optional `{ heartbeatIntervalMs }`, starts `setInterval` on first attach, stops on last detach (avoid eternally ticking timer when no sinks).

**Rationale**:
- Fanout already owns the sink registry; adding the ticker here keeps heartbeat logic co-located with who-to-send-to.
- Stopping ticker when no sinks means idle daemon (no clients) has zero timer load.

**Alternative considered**: ticker always-on from server boot.  Simpler, but burns a timer tick every 30s even with no clients.  Marginal waste; rejected for cleanliness.

### 5. SseSink gains `sendHeartbeat()` method

**Rationale**: the existing `send(msg)` hardcodes `method: 'notifications/contract_event'`.  Adding a branch for heartbeat inside `send()` would crowd one method with two wire formats.  A separate `sendHeartbeat()` is one-liner + clear naming.

### 6. Document limitations honestly

**Decision**: `docs/configs/README.md` adds a "Daemon keep-alive tuning" section that says "this mitigates but does not eliminate rmcp idle-collapse; if codex still crashes after N minutes, restart codex".

**Rationale**: avoid the illusion that this change "fixes codex".  Being upfront about the limit also prevents future "why is codex still broken" bug reports.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Heartbeat notification logged by client as noise | low | user noise | MCP spec says unknown notifications should silent-drop; test via real SDK client |
| Timer leak if detach logic races attach | low | memory leak on heavy reconnect | unit test: attach N + detach N → fanout.peek() empty, timer cleared |
| keepAliveTimeout too long hoards sockets on shared deploys | low | resource exhaustion | 120s is still far below typical OS socket limits (FD_SETSIZE); ENV override available for ops |
| Node `headersTimeout < keepAliveTimeout` mis-config | medium | startup warning | set headersTimeout = keepAliveTimeout + 1000 in build |
| Heartbeat races with `transport.send()` during session shutdown | low | stray error log | `transport.send().catch(…)` already in place swallows post-close send errors |

## Alternatives Considered

1. **Do nothing, document the bug**: leaves opencode / Claude Code SSE users silently exposed; keep-alive default 5s is universally too short.
2. **Implement a full reconnect handshake in daemon side**: over-engineering; the client side has to do half the work anyway.
3. **Poll-based heartbeat (client-initiated)**: would require MCP client changes.
4. **Global heartbeat with fixed interval, no ENV override**: test flakiness + ops rigidity.  ENV override is a cheap addition.

## Rollout

- Zero migration.  Daemon restart picks up new defaults.
- ENV overrides for ops: set `KEEP_ALIVE_TIMEOUT_MS` / `HEARTBEAT_INTERVAL_MS` before `daemon` command.
- Docs updated with both values + the "doesn't fully fix codex" caveat.
