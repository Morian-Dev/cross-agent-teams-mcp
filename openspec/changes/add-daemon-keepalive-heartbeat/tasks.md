# Implementation Tasks — add-daemon-keepalive-heartbeat

Ordered by dependency: HTTP keep-alive config (1) → SSE heartbeat infrastructure (2) → docs (3). All code tasks are TDD RED → GREEN → REFACTOR.

## 1. Fastify keepAliveTimeout default + env override

- [x] 1.1 Configure Fastify with `keepAliveTimeout=120000` default, env-overridable via `KEEP_ALIVE_TIMEOUT_MS`; set `headersTimeout = keepAliveTimeout + 1000`
  - kind: integration-test
  - **Spec scenario(s):**
    - `daemon-core/spec.md` → Scenario: `Default keep-alive timeout when no env var`
    - `daemon-core/spec.md` → Scenario: `Env override applies at boot`
    - `daemon-core/spec.md` → Scenario: `Invalid env value falls back to default`
  - **Files:**
    - Edit: `src/daemon/server.ts` (parse env, pass options to Fastify)
    - Create: `tests/daemon-keepalive-timeout.test.ts`
  - [ ] **INTEGRATION-RED:** Write failing test reading `app.server.keepAliveTimeout` / `app.server.headersTimeout` under three env configurations
    ```ts
    import { describe, it, expect, afterEach } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { startServer } from '../src/daemon/server.js'

    const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-ka-'))

    describe('keep-alive timeout', () => {
      const cleanups: string[] = []
      const savedEnv = { ...process.env }
      afterEach(() => {
        cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0
        for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
        for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v
      })

      it('defaults to 120000 when env unset', async () => {
        delete process.env.KEEP_ALIVE_TIMEOUT_MS
        const dir = tmp(); cleanups.push(dir)
        const { app } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
        expect(app.server.keepAliveTimeout).toBe(120000)
        expect(app.server.headersTimeout).toBe(121000)
        await app.close()
      })

      it('honors env override', async () => {
        process.env.KEEP_ALIVE_TIMEOUT_MS = '60000'
        const dir = tmp(); cleanups.push(dir)
        const { app } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
        expect(app.server.keepAliveTimeout).toBe(60000)
        expect(app.server.headersTimeout).toBe(61000)
        await app.close()
      })

      it('invalid env falls back to default', async () => {
        process.env.KEEP_ALIVE_TIMEOUT_MS = 'not-a-number'
        const dir = tmp(); cleanups.push(dir)
        const { app } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
        expect(app.server.keepAliveTimeout).toBe(120000)
        await app.close()
      })
    })
    ```
  - [x] **Verify INTEGRATION-RED:** Confirm failure because current Fastify has default `keepAliveTimeout=72000` (Fastify v5; proposal originally estimated 5000)
    - Command: `pnpm exec vitest run tests/daemon-keepalive-timeout.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      FAIL  tests/daemon-keepalive-timeout.test.ts > keep-alive timeout > defaults to 120000 when env unset
      AssertionError: expected 72000 to be 120000 // Object.is equality
       ❯ tests/daemon-keepalive-timeout.test.ts:22:41
           22|     expect(app.server.keepAliveTimeout).toBe(120000)
             |                                         ^
      FAIL  tests/daemon-keepalive-timeout.test.ts > keep-alive timeout > honors env override
      AssertionError: expected 72000 to be 60000
       ❯ tests/daemon-keepalive-timeout.test.ts:31:41
      FAIL  tests/daemon-keepalive-timeout.test.ts > keep-alive timeout > invalid env falls back to default
      AssertionError: expected 72000 to be 120000
       ❯ tests/daemon-keepalive-timeout.test.ts:40:41
       Test Files  1 failed (1)
            Tests  3 failed (3)
      ```
  - [x] **INTEGRATION-GREEN:** Update `src/daemon/server.ts`:
    ```ts
    const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 120_000
    function parsePositiveInt(raw: string | undefined, fallback: number): number {
      const n = Number(raw)
      return Number.isInteger(n) && n > 0 ? n : fallback
    }
    // ... inside buildServer:
    const keepAliveTimeout = parsePositiveInt(process.env.KEEP_ALIVE_TIMEOUT_MS, DEFAULT_KEEP_ALIVE_TIMEOUT_MS)
    const app = Fastify({
      logger: false,
      keepAliveTimeout,
      connectionTimeout: 0,  // don't kill on header timeout; Fastify default
    })
    app.server.headersTimeout = keepAliveTimeout + 1000
    ```
  - [x] **Verify INTEGRATION-GREEN:**
    - Command: `pnpm exec vitest run tests/daemon-keepalive-timeout.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/daemon-keepalive-timeout.test.ts > keep-alive timeout > defaults to 120000 when env unset
       ✓ tests/daemon-keepalive-timeout.test.ts > keep-alive timeout > honors env override
       ✓ tests/daemon-keepalive-timeout.test.ts > keep-alive timeout > invalid env falls back to default
       Test Files  1 passed (1)
            Tests  3 passed (3)
      Full suite:
       Test Files  53 passed (53)
            Tests  132 passed (132)
         Duration  3.63s
      ```
  - [x] **REFACTOR:** `parsePositiveInt` is trivial; keep inline. Confirm no new lint warning.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/daemon-keepalive-timeout.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      (No refactor changes made; state identical to GREEN.)
       ✓ tests/daemon-keepalive-timeout.test.ts > keep-alive timeout > defaults to 120000 when env unset
       ✓ tests/daemon-keepalive-timeout.test.ts > keep-alive timeout > honors env override
       ✓ tests/daemon-keepalive-timeout.test.ts > keep-alive timeout > invalid env falls back to default
       Test Files  1 passed (1)
            Tests  3 passed (3)
      ```
  - [x] **Commit:** `feat(daemon): extend HTTP keepAliveTimeout default to 120s with env override`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `622a54e`

## 2. SSE heartbeat ticker on SseFanout

- [x] 2.1 Add `sendHeartbeat(): void` to `SseSink` interface; implement in the sink defined at `src/mcp/transport.ts`
  - kind: unit-test
  - **Spec scenario(s):**
    - `daemon-core/spec.md` → Scenario: `Heartbeat delivered at configured interval`
  - **Files:**
    - Edit: `src/daemon/sse-fanout.ts` (interface + implementation; constructor opt; ticker lifecycle)
    - Edit: `src/mcp/transport.ts` (sink gets sendHeartbeat)
    - Create: `tests/sse-fanout-heartbeat.test.ts`
  - [ ] **RED:** Write failing unit test using `vi.useFakeTimers()` + spy sink; after 250ms advance, spy called ≥2 times
    ```ts
    import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
    import { SseFanout, type SseSink } from '../src/daemon/sse-fanout.js'

    describe('SseFanout heartbeat', () => {
      beforeEach(() => vi.useFakeTimers())
      afterEach(() => vi.useRealTimers())

      it('ticks on every attached sink at the configured interval', () => {
        const fanout = new SseFanout({ heartbeatIntervalMs: 100 })
        const sink: SseSink = {
          send: vi.fn(),
          sendHeartbeat: vi.fn(),
          close: vi.fn()
        }
        fanout.attach('sess-A', 'default', sink)
        vi.advanceTimersByTime(250)
        expect((sink.sendHeartbeat as any).mock.calls.length).toBeGreaterThanOrEqual(2)
      })

      it('stops ticker when last sink detaches', () => {
        const fanout = new SseFanout({ heartbeatIntervalMs: 100 })
        const sink: SseSink = { send: vi.fn(), sendHeartbeat: vi.fn(), close: vi.fn() }
        fanout.attach('sess-A', 'default', sink)
        vi.advanceTimersByTime(150)
        const before = (sink.sendHeartbeat as any).mock.calls.length
        fanout.detach('sess-A')
        vi.advanceTimersByTime(500)
        const after = (sink.sendHeartbeat as any).mock.calls.length
        expect(after).toBe(before)  // no further ticks after detach
      })
    })
    ```
  - [x] **Verify RED:** Fails because current `SseFanout` has no heartbeat and current `SseSink` has no `sendHeartbeat`
    - Command: `pnpm exec vitest run tests/sse-fanout-heartbeat.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       × tests/sse-fanout-heartbeat.test.ts > SseFanout heartbeat > ticks on every attached sink at the configured interval
         → expected 0 to be greater than or equal to 2
       ✓ tests/sse-fanout-heartbeat.test.ts > SseFanout heartbeat > stops ticker when last sink detaches
      AssertionError: expected 0 to be greater than or equal to 2
       ❯ tests/sse-fanout-heartbeat.test.ts:17:59
           17|     expect((sink.sendHeartbeat as any).mock.calls.length).toBeGreaterT…
             |                                                           ^
       Test Files  1 failed (1)
            Tests  1 failed | 1 passed (2)
      ```
  - [x] **GREEN:** Update `src/daemon/sse-fanout.ts`:
    ```ts
    export interface SseSink {
      send(msg: Record<string, unknown>): void
      sendHeartbeat(): void
      close(): void
    }

    const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000

    function resolveHeartbeatIntervalMs(opt?: number): number {
      if (typeof opt === 'number' && opt > 0) return opt
      const n = Number(process.env.HEARTBEAT_INTERVAL_MS)
      return Number.isInteger(n) && n > 0 ? n : DEFAULT_HEARTBEAT_INTERVAL_MS
    }

    export class SseFanout {
      private sessions = new Map<string, Session>()
      private heartbeatTimer: ReturnType<typeof setInterval> | undefined
      private readonly heartbeatIntervalMs: number

      constructor(opts: { heartbeatIntervalMs?: number } = {}) {
        this.heartbeatIntervalMs = resolveHeartbeatIntervalMs(opts.heartbeatIntervalMs)
      }

      attach(agent_id: string, team: string, sink: SseSink): void {
        const wasEmpty = this.sessions.size === 0
        this.sessions.set(agent_id, { agent_id, team, sink })
        if (wasEmpty) this.startHeartbeat()
      }

      detach(agent_id: string): void {
        const s = this.sessions.get(agent_id)
        if (s) { try { s.sink.close() } catch { /* ignore */ } this.sessions.delete(agent_id) }
        if (this.sessions.size === 0) this.stopHeartbeat()
      }

      stopAll(): void {
        this.stopHeartbeat()
        for (const s of this.sessions.values()) { try { s.sink.close() } catch { /* ignore */ } }
        this.sessions.clear()
      }

      private startHeartbeat(): void {
        if (this.heartbeatTimer) return
        this.heartbeatTimer = setInterval(() => {
          for (const s of this.sessions.values()) {
            try { s.sink.sendHeartbeat() } catch { /* ignore */ }
          }
        }, this.heartbeatIntervalMs)
        if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref()
      }

      private stopHeartbeat(): void {
        if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = undefined }
      }

      // rebind / peek / emitContractEvent unchanged
    }
    ```
    Update `src/mcp/transport.ts` sink to add:
    ```ts
    sendHeartbeat(): void {
      void transport.send({ jsonrpc: '2.0' as const, method: 'notifications/heartbeat', params: {} }).catch(() => { /* no active GET */ })
    }
    ```
    Update `src/daemon/server.ts` `onClose` hook to call `fanout.stopAll()` before db.close().
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/sse-fanout-heartbeat.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/sse-fanout-heartbeat.test.ts > SseFanout heartbeat > ticks on every attached sink at the configured interval
       ✓ tests/sse-fanout-heartbeat.test.ts > SseFanout heartbeat > stops ticker when last sink detaches
       Test Files  1 passed (1)
            Tests  2 passed (2)
      Full suite:
       Test Files  54 passed (54)
            Tests  134 passed (134)
         Duration  3.59s
      ```
  - [x] **REFACTOR:** None; startHeartbeat/stopHeartbeat are the minimal pair.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/sse-fanout-heartbeat.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      (No refactor changes made; state identical to GREEN.)
       ✓ tests/sse-fanout-heartbeat.test.ts > SseFanout heartbeat > ticks on every attached sink at the configured interval
       ✓ tests/sse-fanout-heartbeat.test.ts > SseFanout heartbeat > stops ticker when last sink detaches
       Test Files  1 passed (1)
            Tests  2 passed (2)
      ```
  - [x] **Commit:** `feat(sse-fanout): add application-level heartbeat ticker with attach/detach lifecycle`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `__TASK_2_1_SHA__`

- [ ] 2.2 MCP client end-to-end: receives `notifications/heartbeat`
  - kind: integration-test
  - **Spec scenario(s):**
    - `daemon-core/spec.md` → Scenario: `MCP client receives notifications/heartbeat`
    - `daemon-core/spec.md` → Scenario: `First attach starts the ticker`
    - `daemon-core/spec.md` → Scenario: `Last detach stops the ticker`
  - **Files:**
    - Create: `tests/mcp-heartbeat-e2e.test.ts`
  - [ ] **INTEGRATION-RED:** Client connects, registers a notification handler for `notifications/heartbeat`, waits ~400ms with `HEARTBEAT_INTERVAL_MS=100`, asserts ≥ 1 heartbeat received.
    ```ts
    import { describe, it, expect, afterEach } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { Client } from '@modelcontextprotocol/sdk/client/index.js'
    import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
    import { z } from 'zod'
    import { startServer } from '../src/daemon/server.js'

    const HeartbeatNotification = z.object({
      jsonrpc: z.literal('2.0'),
      method: z.literal('notifications/heartbeat'),
      params: z.any().optional()
    })

    describe('mcp heartbeat end-to-end', () => {
      const cleanups: string[] = []
      const savedEnv = { ...process.env }
      afterEach(() => {
        cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0
        for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
        for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v
      })

      it('client receives at least one heartbeat notification within 400ms at interval 100ms', async () => {
        process.env.HEARTBEAT_INTERVAL_MS = '100'
        const dir = tmp(); cleanups.push(dir)
        const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
        const url = new URL(`http://${host}:${port}/mcp`)
        const transport = new StreamableHTTPClientTransport(url)
        const client = new Client({ name: 'test', version: '0.0.0' })

        let received = 0
        client.setNotificationHandler(HeartbeatNotification as any, async () => { received += 1 })
        await client.connect(transport)
        // force register so that the session's sink is attached to fanout
        await client.callTool({ name: 'register_agent', arguments: { model: 'opus-4-7', role: 'test' } })

        await new Promise(r => setTimeout(r, 400))
        expect(received).toBeGreaterThanOrEqual(1)

        await transport.close(); await app.close()
      })
    })
    const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-hbe2e-'))
    ```
  - [ ] **Verify INTEGRATION-RED:** Fails because the daemon currently does not emit heartbeats
    - Command: `pnpm exec vitest run tests/mcp-heartbeat-e2e.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **INTEGRATION-GREEN:** Already achieved by task 2.1's implementation. This task only adds the e2e test to pin the behavior through the real SDK + HTTP path.
  - [ ] **Verify INTEGRATION-GREEN:**
    - Command: `pnpm exec vitest run tests/mcp-heartbeat-e2e.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **REFACTOR:** None
  - [ ] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/mcp-heartbeat-e2e.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **Commit:** `test(mcp): end-to-end heartbeat notification delivery via streamable-http client`
    - **Commit SHA (fill during apply):** `<to be filled by ts-apply>`

- [ ] 2.3 Heartbeat does not interfere with contract_event delivery
  - kind: integration-test
  - **Spec scenario(s):**
    - `daemon-core/spec.md` → Scenario: `Heartbeat does not interfere with contract_event delivery`
  - **Files:**
    - Edit: `tests/sse-e2e.test.ts` (extend if the scenario fits cleanly) OR Create: `tests/sse-fanout-coexistence.test.ts`
  - [ ] **INTEGRATION-RED:** With `HEARTBEAT_INTERVAL_MS=100`, connect subscriber, then emit a contract_event; assert subscriber receives contract_event AND at least one heartbeat, and the two are ordered correctly (contract_event payload intact, not mutated by heartbeat).
    ```ts
    // full-suite safe: new test file. Subscriber uses register_agent + register_contract + subscribe_contract, then waits 300ms and emits update; asserts both heartbeat count >= 1 AND at least 1 contract_event received.
    ```
  - [ ] **Verify INTEGRATION-RED:** If tasks 1.1 + 2.1 have landed, heartbeat runs and contract_event path is unchanged; the test should PASS immediately — a regression guard rather than a red-first test. Capture output.
    - Command: `pnpm exec vitest run <the test file> --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **INTEGRATION-GREEN:** No additional production change. This test pins the non-interference invariant.
  - [ ] **Verify INTEGRATION-GREEN:**
    - Command: `pnpm exec vitest run <the test file> --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **REFACTOR:** None
  - [ ] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run <the test file> --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **Commit:** `test(sse): heartbeat coexists with contract_event stream without interference`
    - **Commit SHA (fill during apply):** `<to be filled by ts-apply>`

## 3. Docs: daemon tuning section

- [ ] 3.1 Update `docs/configs/README.md` with "Daemon keep-alive tuning" section (default values, ENV overrides, honest disclaimer about codex)
  - kind: manual-verify
  - **Spec scenario(s):** n/a (documentation-only)
  - **Files:**
    - Edit: `docs/configs/README.md`
  - [ ] **IMPLEMENT:** Append a section like:
    ```markdown
    ## Daemon keep-alive tuning

    The daemon ships with two idle-tolerance knobs:

    - `KEEP_ALIVE_TIMEOUT_MS` (default `120000`, 120s) — HTTP short-connection keep-alive window. Applies to streamable-http POST clients like codex rmcp.
    - `HEARTBEAT_INTERVAL_MS` (default `30000`, 30s) — application-level `notifications/heartbeat` emitted to every attached SSE sink. Keeps long-lived subscription streams TCP-active through NAT / firewall idle timers.

    To override (e.g. for ops tuning or for tests):
        KEEP_ALIVE_TIMEOUT_MS=60000 HEARTBEAT_INTERVAL_MS=15000 node dist/cli.js daemon

    **Honest limitation**: these mitigations widen the window but do NOT fully fix the codex rmcp idle-transport collapse ("error decoding response body"). The root cause is in codex's HTTP connection pool lacking retry-on-decode-error; it's outside this daemon's control. If codex still crashes after `KEEP_ALIVE_TIMEOUT_MS` seconds of idle, restart codex and re-register.
    ```
  - [ ] **MANUAL-VERIFY:** user reads the new section and confirms wording + placement
    - Record evidence via AskUserQuestion at driver scope (subagent harness lacks it; apply-fixup pattern)
    - **Evidence (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **Commit:** `docs(configs): document keep-alive + heartbeat env tuning with honest codex caveat`
    - **Commit SHA (fill during apply):** `<to be filled by ts-apply>`

## Scenario Coverage Matrix

| Spec scenario | Test file | Task |
|---|---|---|
| `Default keep-alive timeout when no env var` | `tests/daemon-keepalive-timeout.test.ts` | 1.1 |
| `Env override applies at boot` | `tests/daemon-keepalive-timeout.test.ts` | 1.1 |
| `Invalid env value falls back to default` | `tests/daemon-keepalive-timeout.test.ts` | 1.1 |
| `First attach starts the ticker` | `tests/sse-fanout-heartbeat.test.ts` + `tests/mcp-heartbeat-e2e.test.ts` | 2.1, 2.2 |
| `Last detach stops the ticker` | `tests/sse-fanout-heartbeat.test.ts` | 2.1 |
| `Heartbeat delivered at configured interval` | `tests/sse-fanout-heartbeat.test.ts` | 2.1 |
| `MCP client receives notifications/heartbeat` | `tests/mcp-heartbeat-e2e.test.ts` | 2.2 |
| `Heartbeat does not interfere with contract_event delivery` | new `tests/sse-fanout-coexistence.test.ts` or extension of `tests/sse-e2e.test.ts` | 2.3 |

Total unique spec scenarios: 8. Total top-level tasks: 4 (1.1, 2.1, 2.2, 2.3, 3.1 — 5 including docs manual-verify). Every scenario has at least one task-level test assertion.
