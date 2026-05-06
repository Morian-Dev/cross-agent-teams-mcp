## Context

Heap-snapshot evidence (May 2026 leak hunt):

- Clean isolated test (1 hammer client, 114 echo calls, no proxies): only 1 session created, ~0.3 ZodOptional/call. Per-call zod allocation noise is small.
- Dirty test (5 hammer clients + 9 channel proxies, 1460 calls): 569 sessions created in 30 s. AgentsRepo +2276 = exactly 4× sessions (4 `new AgentsRepo(db)` per session creation). Channel-proxy `loop()` cycles `runRegistrationSequence` → `register_agent` collision → 500 ms wait → retry, ~2 attempts/sec/proxy × 9 = 18 sessions/sec. Each session retains ~25 tool registrations + zod schemas + closures (~400 KB). Linear daemon RSS growth ~3.7 MB/s. V8 OOM in ~20 min on default heap, ~6 min on `--max-old-space-size=2048`.

Root cause has three independent layers (any single layer fixed is enough to slow the leak; together they eliminate it):

1. `register-agent.ts` rejects the legitimate "same proxy, new connection" case as `agent_id_collision`, even though semantically it is a takeover.
2. `transport.ts` keeps every successfully-initialized MCP session in its `sessions` Map indefinitely; entries are removed only when the SDK transport's `onclose` fires, which fires only on `DELETE /mcp` — and no client sends DELETE.
3. `daemon-client.ts` polls `echo` every 200 ms in `waitForDisconnect`. Under any sustained daemon load, transient errors trigger reconnect, which compounds layers (1) and (2).

## Goals / Non-Goals

**Goals:**

- Daemon RSS stays bounded under realistic multi-host load (≥9 channel proxies + 1-3 user-facing CLIs) without manual intervention.
- User-facing MCP sessions (Claude Code, Codex, opencode primary clients) are NEVER reaped. Their workflow — long idle periods, then resume by typing — must be unaffected.
- Channel-proxy reconnect after transient daemon hiccup converges to ONE active session per `(team, name)` rather than accumulating phantoms.

**Non-Goals:**

- Per-call zod allocation reduction inside the MCP SDK or zod itself. The 28 `native_bind` closures per call observed in the clean test are SDK/zod internals; out of scope for this change. (Tracked as future work if RSS still drifts after this change.)
- Reducing the steady-state allocation cost of a single MCP session (tool registration, McpServer instance). Improvable but disjoint from the leak.
- Any change to client-facing tool semantics (echo, send_message, register_agent payloads). Only register_agent's COLLISION branch changes behaviour.

## Decisions

### Decision 1: Replace `agent_id_collision` with takeover semantics

When `register_agent` is called with an existing `(team, name)` from a different `connection_id`:

- **Before**: return `{ error: 'agent_id_collision' }`. Caller must figure out the conflict.
- **After**: daemon performs:
  1. Look up the prior session by old `connection_id` (passed via `getSessionId()` at registration time, stored in `RegisterAgentService.connections`).
  2. Update `connections.set(key, new_connection_id)` so subsequent calls see the new owner.
  3. Notify the transport layer to close the OLD session's MCP transport. Closing the transport propagates to `transport.onclose` in `mountMcp`, which removes the session from `sessions` Map, releases SSE fanout, releases channelWakeFanout binding, and frees the McpServer + zod schema retainers.

**Why takeover over collision-error**:

- Channel proxies legitimately reconnect with the same `(team, name)` (pid-keyed) when their MCP socket goes through a transient blip. The current behaviour is hostile to this real workflow.
- The previous binding has by definition been abandoned by its owner — a different connection id implies a different MCP session id, which only arises when the client opened a fresh connection. The old session has no path back.
- Symmetric to other identity systems (single-sign-on style). Last writer wins; old session is cleanly torn down rather than leaking.

**Rejected alternatives**:

- Keep collision error, fix proxy to send DELETE before reconnecting. Touches the wire protocol from the proxy side and assumes proxy code paths can detect "I'm about to reconnect" cleanly. Brittle.
- Keep collision error, fix proxy to back off harder. Still leaks every transient, just slower; doesn't address the architectural mismatch.

### Decision 2: Orphan-session GC keyed on registration completion

Add a periodic ticker in `mountMcp` (or in `daemon/server.ts` next to `runCleanup`) that walks `sessions` Map and force-closes any session where:

- `agentIdHolder.current === undefined` (no successful `register_agent` yet), AND
- `session.createdAt < now - 60_000 ms`.

Force-close calls `session.transport.close()` which triggers the existing onclose chain.

**Why this criterion specifically**:

- `agentIdHolder.current === undefined` is the precise signal that a session is a phantom. Real MCP clients always call `register_agent` within a few hundred ms of `initialize`. The 60 s grace period absorbs slow startup, weird network conditions, and human-driven manual `register_agent` from a debugging shell.
- It is INTRINSICALLY safe for user-facing sessions: any session that has called `register_agent` even once has `agentIdHolder.current` set, and the GC walks past it forever after.
- Decision 1's takeover already cleans up old REGISTERED sessions when a new one supersedes them. Decision 2 catches the residual case where the new registration ALSO fails (e.g. proxy code path that errors out before `register_agent`). Belt + suspenders.

**Rejected alternatives**:

- Time-based GC for all idle sessions (e.g. 24 h). Touches user-facing sessions. Risk of breaking workflow if user is away longer than threshold.
- Activity-based GC (`lastActivityAt`). Prone to mis-classifying long-idle but valid sessions.
- Cap on `sessions.size`. Hides the leak rather than fixes it; LRU eviction has nondeterministic UX.

### Decision 3: Channel-proxy `waitForDisconnect` heartbeat 200 ms → 30 s default

`plugins/cross-agent-teams-channel/src/daemon-client.ts:109` currently:

```ts
const interval = config.healthCheckIntervalMs ?? 200
```

becomes:

```ts
const interval = config.healthCheckIntervalMs ?? 30_000
```

`transport.onclose` already fires immediately on TCP socket break, which is the primary fast-path disconnect signal. The echo poll is a coarse-grained "daemon process is wedged but socket appears OK" backstop, for which 30 s is plenty.

**Why 30 s and not 60 s/5 min/etc.**:

- Below 30 s: amplifies any per-call SDK allocation. With Decisions 1 + 2 the per-call allocation no longer leaks, but the SDK's bind-closure count per call is still non-zero, and a tighter loop costs CPU + GC pressure for no benefit.
- Above 30 s: increases user-visible latency between "daemon hung" and "proxy noticed it hung". 30 s feels right for a backstop.
- Configurable via `config.healthCheckIntervalMs` for tests; not surfaced as a public CLI flag.

## Risks / Trade-offs

- **[Risk]** Takeover may mask client-side bugs that genuinely double-register (two different processes both claiming `(team='default', name='alice')`). → **Mitigation**: existing daemon log lines record each register/release; takeover events MUST log "takeover: closing old session <oldSid> for (team,name)" so a flapping `(team, name)` is visible in logs. Add a debug-level log in `register-agent.ts` for the takeover branch.
- **[Risk]** Orphan-session GC fires too eagerly and reaps a session whose `register_agent` was unusually slow. → **Mitigation**: 60 s grace is ~50× the slowest typical register call (round-trip + sqlite upsert + delivery validation). If profiling later shows real registrations exceeding 60 s, the threshold becomes a server option without API churn.
- **[Risk]** Old session closure during takeover triggers concurrent activity on the about-to-die transport (e.g. an in-flight tool call). → **Mitigation**: `transport.close()` cancels in-flight via the abort controller chain in the SDK; the in-flight call resolves with an abort error on its way out. The closing-side observer (channel-proxy) sees this as a transport-error and naturally cycles via its existing reconnect path — same as today on a daemon restart.
- **[Risk]** Channel-proxy 30 s heartbeat misses a daemon hang where the TCP socket is alive but the daemon event loop is wedged. → **Mitigation**: 30 s is bounded delay; `transport.onclose` still wins on socket-level failures (the much more common case). For event-loop wedge specifically, ops would notice via daemon log / health endpoint long before proxy heartbeat.

## Migration Plan

- This is a daemon-internal change. Daemon must be restarted to pick up the new behaviour.
- Channel-proxy is the same npm package (`cross-agent-teams-mcp`) — proxies will pick up the new heartbeat default the next time their host CLI restarts and `npx ...channel-cli` resolves the new published version.
- No data migration; sessions Map is in-memory.
- Rollback: revert package version. Behaviour returns to current.

## Open Questions

(none — all three decisions are mechanical refactors with clear empirical motivation)
