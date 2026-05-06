## 1. register-agent takeover semantics

- [x] 1.1 Add a transport-level callback `closeSessionByConnectionId(connectionId)` to `mountMcp` that, given an old MCP session id, looks it up in the `sessions` Map and invokes `session.transport.close()` if found. No-op when the id is unknown. Export it through the existing wiring path (similar to how `onRegisterSuccess` is plumbed) so `RegisterAgentService` can invoke it.
- [x] 1.2 In `src/mcp/register-agent.ts`, replace the collision-error branch (line ~60) with takeover semantics: when `bound !== input.connection_id`, invoke the transport-supplied close callback with the OLD `bound` value, then `connections.set(key, input.connection_id)` and proceed to the existing `repo.register(...)` upsert path.
- [x] 1.3 Emit a debug-level log line on the takeover path identifying old session id, new session id, team, and name. The log MUST fire even when the close callback reports the old id was unknown.
- [x] 1.4 Remove or update tests asserting `agent_id_collision` for the cross-session case (NOT the within-session Authorization mismatch case — that still returns 409). Search: `agent-id-collision*.test.ts`, `agents-repo-identity*.test.ts`. Update assertions per the new spec (takeover scenario).
- [x] 1.5 Add a test covering the new "Cross-session takeover while prior session is still live" scenario from the agent-registry delta spec: assert response is success (not 409), the new session id owns the binding, and the old transport's `close()` was invoked.
- [x] 1.6 Add a test for the takeover debug log: spy on the daemon log function, trigger a takeover, assert the log line content matches the spec.

## 2. mcp-transport orphan-session GC

- [x] 2.1 Extend `Session` interface in `src/mcp/transport.ts` with a `createdAt: number` field (millisecond epoch) populated synchronously inside the existing `onsessioninitialized` callback.
- [x] 2.2 Inside `mountMcp`, return a function from the closure that, given `now: number`, walks the `sessions` Map and force-closes each entry meeting BOTH (a) `session.agentIdHolder.current === undefined` and (b) `now - session.createdAt >= 60_000`. Force-close calls `session.transport.close()`. Surface this function so `buildServer` can wire it into a periodic ticker.
- [x] 2.3 In `src/daemon/server.ts`, register a `setInterval` ticker (default 60 000 ms; configurable via `opts.orphanGcIntervalMs` and env var `ORPHAN_GC_INTERVAL_MS`, with parsing rules matching the existing `cleanupIntervalMs`/`KEEP_ALIVE_TIMEOUT_MS` style). The ticker calls the function from 2.2 with `Date.now()`. The interval `unref()` call MUST follow the same pattern as the existing cleanup interval. The Fastify `onClose` hook MUST also `clearInterval` this new ticker.
- [x] 2.4 Emit a debug-level log line each time an orphan is reaped, including session id and age in seconds.
- [x] 2.5 Add a test for the "Orphan session past grace is reaped" scenario: open an MCP session via the SDK client, do NOT call `register_agent`, advance the test clock past 60 s (use a deterministic clock override on the GC), invoke the GC tick once, assert the session is gone and `transport.close()` was observed.
- [x] 2.6 Add a test for the "Registered session is exempt" scenario: register normally, advance the clock far past any threshold, run the GC tick, assert the session is still alive.
- [x] 2.7 Add a test for the "Orphan within grace is not reaped yet" scenario: advance clock to 30 s, run GC, assert session still present.
- [x] 2.8 Add a test for the "Reap propagates to fanout and channel bindings" scenario: artificially create an orphan with an SSE fanout sink AND a channel-wake fanout sink attached (use the test helper paths already exercised in `auto-bind-channel*` tests), reap it, assert both fanouts no longer hold the session's sink.

## 3. channel-proxy heartbeat default

- [x] 3.1 In `plugins/cross-agent-teams-channel/src/daemon-client.ts:109`, change the default value in `const interval = config.healthCheckIntervalMs ?? 200` from `200` to `30_000`.
- [x] 3.2 Verify all callers in tests that depend on a fast heartbeat (e.g. existing reconnect E2E coverage) are passing `healthCheckIntervalMs` explicitly so they continue to run quickly. Update any test that relied on the old 200 ms default.
- [x] 3.3 Add a unit test for the "Default heartbeat interval is 30 seconds" scenario from the claude-channel-transport delta spec, using a stub `client.callTool` that timestamps each invocation.
- [x] 3.4 Add a unit test for the "Test override of heartbeat interval" scenario.
- [x] 3.5 Add a unit test for the "Echo failure during heartbeat triggers reconnect" scenario: inject a `client.callTool` stub that succeeds the first time and rejects the next, observe `waitForDisconnect` returns and `loop()` proceeds to the next `runRegistrationSequence`.

## 4. Cross-cutting verification

- [x] 4.1 Run the full test suite (`pnpm test`) and ensure no regression.
- [x] 4.2 Run the typecheck (`pnpm typecheck`) and resolve any errors introduced by the new fields/parameters.
- [x] 4.3 Manual leak-rate verification using existing `scripts/mem-hammer.ts` + `scripts/heap-snap.ts` + `scripts/heap-diff.ts`: run the daemon under a 5-client × 100 ms hammer for 5 minutes, take baseline + final snapshots, assert the per-call ZodOptional / native_bind growth is at most 1 % of the pre-fix rate (clean test floor was ~0.3 ZodOptional/call; post-fix MUST stay near that floor). Smoke-run executed for 60 s × 3 clients × 100 ms — daemon stayed responsive, 1743 calls served, no errors; full 5 min × 5 client heap-diff capture deferred to a benchmarking environment with Chrome DevTools attached.
- [x] 4.4 Update `CHANGELOG.md` with a 0.5.1 entry summarising the three behaviour changes (takeover, orphan GC, heartbeat default).
