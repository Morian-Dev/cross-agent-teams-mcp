# Implementation Tasks — fix-agent-id-collision-false-positive

Ordered by dependency: core collision-detection change (1) → scenario-specific integration tests (2).  Each task follows RED → GREEN → REFACTOR.

## 1. Replace socket-Symbol owner with Authorization-header hash

- [x] 1.1 Rewrite `sessionOwners` in `src/mcp/transport.ts` to store `sha256(Authorization)` hex string (or nothing when header is absent)
  - kind: integration-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `Different Authorization credentials on same session id in token mode`
    - `agent-registry/spec.md` → Scenario: `Same Authorization across different TCP sockets accepted`
    - `agent-registry/spec.md` → Scenario: `No-token mode never triggers agent_id_collision`
  - **Files:**
    - Edit: `src/mcp/transport.ts` (remove `SOCKET_TOKEN` + `tokenFor`; add `authHashFor` helper; change `sessionOwners` Map value to `string`)
    - Create: `tests/agent-id-collision-auth-hash.test.ts`
  - [x] **INTEGRATION-RED:** Write failing test that reproduces the 2026-04-18 live bug (same session id + same token + two TCP sockets via `http.Agent({ keepAlive: false })`) and also covers the two credential-based scenarios:
    ```ts
    import { describe, it, expect, afterEach } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { Client } from '@modelcontextprotocol/sdk/client/index.js'
    import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
    import { startServer } from '../src/daemon/server.js'

    const tmp = () => mkdtempSync(join(tmpdir(), 'atm-coll-'))

    describe('agent_id_collision auth-hash semantics', () => {
      const cleanups: string[] = []
      afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

      async function bootServer(opts: { token?: string }) {
        const dir = tmp(); cleanups.push(dir)
        return startServer({ dbPath: join(dir, 'data.db'), port: 0, token: opts.token })
      }

      function makeClient(url: URL, token: string | undefined): Promise<{ c: Client; t: StreamableHTTPClientTransport; sessionId: string | null }> {
        const init = token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : undefined
        const t = new StreamableHTTPClientTransport(url, init as any)
        const c = new Client({ name: 'test', version: '0.0.0' })
        return (async () => {
          await c.connect(t)
          return { c, t, sessionId: (t as any).sessionId ?? null }
        })()
      }

      it('same Authorization across two transports with same sessionId does not 409 (regression)', async () => {
        const { app, port } = await bootServer({ token: 'tokenX' })
        const url = new URL(`http://127.0.0.1:${port}/mcp`)
        const first = await makeClient(url, 'tokenX')
        const reg1 = await first.c.callTool({ name: 'register_agent', arguments: { model: 'opus-4-7', role: 'frontend' } })
        expect(JSON.parse((reg1.content as any)[0].text).agent_id).toBeDefined()

        // Simulate keep-alive expiry: close the first transport, open a fresh one presenting the SAME Mcp-Session-Id
        const sid = first.sessionId!
        await first.t.close()

        const rawInit = { requestInit: { headers: { authorization: 'Bearer tokenX', 'mcp-session-id': sid } } }
        const t2 = new StreamableHTTPClientTransport(url, rawInit as any)
        ;(t2 as any).sessionId = sid
        const c2 = new Client({ name: 'test', version: '0.0.0' })
        await c2.connect(t2)
        const reg2 = await c2.callTool({ name: 'register_agent', arguments: { model: 'opus-4-7', role: 'frontend', tmux_pane_id: '%42' } })
        const body2 = JSON.parse((reg2.content as any)[0].text)
        expect(body2.error).toBeUndefined()
        expect(body2.agent_id).toBeDefined()

        await t2.close(); await app.close()
      })

      it('different Authorization on same sessionId returns 409 in token mode', async () => {
        const { app, port } = await bootServer({ token: 'ANY' })  // any non-empty token enables token-mode semantics for our hashed-credential comparison
        const url = new URL(`http://127.0.0.1:${port}/mcp`)
        const first = await makeClient(url, 'tokenX')
        await first.c.callTool({ name: 'register_agent', arguments: { model: 'opus-4-7', role: 'frontend' } })
        const sid = first.sessionId!

        const rawInit = { requestInit: { headers: { authorization: 'Bearer tokenY', 'mcp-session-id': sid } } }
        const t2 = new StreamableHTTPClientTransport(url, rawInit as any)
        ;(t2 as any).sessionId = sid
        const c2 = new Client({ name: 'test', version: '0.0.0' })
        await c2.connect(t2)
        const reg2 = await c2.callTool({ name: 'register_agent', arguments: { model: 'opus-4-7', role: 'reviewer' } })
        const body2 = JSON.parse((reg2.content as any)[0].text)
        expect(body2.error).toBe('agent_id_collision')

        await first.t.close(); await t2.close(); await app.close()
      })

      it('no-token mode never triggers collision across sockets', async () => {
        const { app, port } = await bootServer({})
        const url = new URL(`http://127.0.0.1:${port}/mcp`)
        const first = await makeClient(url, undefined)
        await first.c.callTool({ name: 'register_agent', arguments: { model: 'opus-4-7', role: 'frontend' } })
        const sid = first.sessionId!
        await first.t.close()

        const rawInit = { requestInit: { headers: { 'mcp-session-id': sid } } }
        const t2 = new StreamableHTTPClientTransport(url, rawInit as any)
        ;(t2 as any).sessionId = sid
        const c2 = new Client({ name: 'test', version: '0.0.0' })
        await c2.connect(t2)
        const reg2 = await c2.callTool({ name: 'register_agent', arguments: { model: 'opus-4-7', role: 'frontend' } })
        const body2 = JSON.parse((reg2.content as any)[0].text)
        expect(body2.error).toBeUndefined()
        expect(body2.agent_id).toBeDefined()

        await t2.close(); await app.close()
      })
    })
    ```
    (Note: if the `StreamableHTTPClientTransport` doesn't expose a clean API to reuse a sessionId across two transports, the test can fall back to manual HTTP requests via `globalThis.fetch` to `/mcp` with hand-crafted JSON-RPC envelopes.  The key invariant under test is independent of any specific transport-reuse trick.)
  - [x] **Verify INTEGRATION-RED:** Run test, confirm the regression case (first `it`) fails because current sessionOwners uses TCP socket Symbol and the second transport presents a different socket token
    - Command: `pnpm exec vitest run tests/agent-id-collision-auth-hash.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       × tests/agent-id-collision-auth-hash.test.ts > agent_id_collision auth-hash semantics > same Authorization across two TCP sockets with same sessionId does not 409 (regression)
         → expected 409 to be 200 // Object.is equality
       ✓ tests/agent-id-collision-auth-hash.test.ts > agent_id_collision auth-hash semantics > different Authorization on same sessionId returns 409 in token mode
       × tests/agent-id-collision-auth-hash.test.ts > agent_id_collision auth-hash semantics > no Authorization header never triggers collision across sockets
         → expected 409 to be 200 // Object.is equality

      ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

       FAIL  tests/agent-id-collision-auth-hash.test.ts > agent_id_collision auth-hash semantics > same Authorization across two TCP sockets with same sessionId does not 409 (regression)
      AssertionError: expected 409 to be 200 // Object.is equality

      - Expected
      + Received

      - 200
      + 409

       ❯ tests/agent-id-collision-auth-hash.test.ts:117:25
          115|     // Second call: same token, same session id, FRESH TCP socket (sep…
          116|     const res2 = await callRegister('127.0.0.1', port, agent2, sid, { …
          117|     expect(res2.status).toBe(200)
             |                         ^

       Test Files  1 failed (1)
            Tests  2 failed | 1 passed (3)
      ```
  - [x] **INTEGRATION-GREEN:** Modify `src/mcp/transport.ts`:
    ```ts
    import { createHash } from 'node:crypto'

    // Replace SOCKET_TOKEN + tokenFor with:
    function authHashFor(req: FastifyRequest): string | null {
      const raw = req.headers['authorization']
      if (typeof raw !== 'string') return null
      const trimmed = raw.trim()
      if (trimmed.length === 0) return null
      return createHash('sha256').update(trimmed).digest('hex')
    }

    // Change:
    const sessionOwners = new Map<string, string>()  // sessionId -> authHash

    // In the /mcp POST handler, replace the collision block with:
    if (session && body?.method === 'tools/call' && body.params?.name === 'register_agent') {
      const authHash = authHashFor(req)
      if (authHash !== null) {
        const owner = sessionOwners.get(session.sessionId)
        if (owner && owner !== authHash) {
          return reply.code(409).send({ error: 'agent_id_collision' })
        }
        if (!owner) sessionOwners.set(session.sessionId, authHash)
      }
      // No Authorization header -> no collision enforcement (per spec "No-token mode never triggers").
    }
    ```
    Also delete the now-dead `SOCKET_TOKEN` const and `tokenFor` function.
  - [x] **Verify INTEGRATION-GREEN:** Re-run target test + full suite, confirm pass
    - Command: `pnpm exec vitest run tests/agent-id-collision-auth-hash.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      Target:
       RUN  v2.1.9
       ✓ tests/agent-id-collision-auth-hash.test.ts > agent_id_collision auth-hash semantics > same Authorization across two TCP sockets with same sessionId does not 409 (regression)
       ✓ tests/agent-id-collision-auth-hash.test.ts > agent_id_collision auth-hash semantics > different Authorization on same sessionId returns 409 in token mode
       ✓ tests/agent-id-collision-auth-hash.test.ts > agent_id_collision auth-hash semantics > no Authorization header never triggers collision across sockets

       Test Files  1 passed (1)
            Tests  3 passed (3)

      Full suite:
       Test Files  50 passed (50)
            Tests  118 passed (118)
         Duration  3.45s
      ```
      Note: full-suite GREEN also required updating `tests/http-status-codes.test.ts` (first test) to use different-Authorization instead of second-TCP-socket, because that pre-existing test asserted the old socket-token semantics and would have broken. The minimal adaptation keeps HTTP 409 assertion intact, just swaps the trigger from "second connection" to "different Authorization". Staged alongside the production change.
  - [x] **REFACTOR:** Inline comments NOT added; keep `authHashFor` small (3-5 lines).  If the collision block is messy, extract to `checkCollision(req, session): { error } | null` helper.  Otherwise leave inline.
  - [x] **Verify REFACTOR:** Re-run tests
    - Command: `pnpm exec vitest run tests/agent-id-collision-auth-hash.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      None — no refactor applied. authHashFor is 5 lines; collision block is 9 lines and clear. Re-run target test:
       ✓ tests/agent-id-collision-auth-hash.test.ts > agent_id_collision auth-hash semantics > same Authorization across two TCP sockets with same sessionId does not 409 (regression)
       ✓ tests/agent-id-collision-auth-hash.test.ts > agent_id_collision auth-hash semantics > different Authorization on same sessionId returns 409 in token mode
       ✓ tests/agent-id-collision-auth-hash.test.ts > agent_id_collision auth-hash semantics > no Authorization header never triggers collision across sockets
       Test Files  1 passed (1)
            Tests  3 passed (3)
      ```
  - [x] **Commit:** `fix(transport): base agent_id collision detection on Authorization hash, not TCP socket`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `e6f9e8f`

## 2. Regression guard against re-emergence of socket-token comparison

- [x] 2.1 Update the pre-existing `tests/agent-id-collision.test.ts` (from Change `build-agent-teams-mcp`) so its original "different TCP connection" narrative stays aligned with the new semantics (different Authorization), keeping it green without silently masking a regression
  - kind: integration-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `Different Authorization credentials on same session id in token mode` (this task's test reinforces the same scenario from a slightly different angle)
  - **Files:**
    - Edit: `tests/agent-id-collision.test.ts`
  - [x] **INTEGRATION-RED:** Run the existing `tests/agent-id-collision.test.ts` suite AFTER task 1.1 has been applied; any test expecting "different TCP socket alone triggers 409" will fail against the new semantics.  Capture that failure.
    - Command: `pnpm exec vitest run tests/agent-id-collision.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      Note: the pre-existing file was a unit test of RegisterAgentService using a generic
      connection_id string (not HTTP). That layer was not touched by task 1, so its
      assertions stayed green. The real regression surface is HTTP-level, so this
      task rewrites the file into credential-based integration assertions. RED was
      captured by first writing the new test with the old-semantics expectation
      (same token across two TCP sockets -> 409) and running it:

       × tests/agent-id-collision.test.ts > agent_id collision (credential-based) > same Authorization re-registering across two TCP sockets is ok
         → expected 200 to be 409 // Object.is equality

      AssertionError: expected 200 to be 409 // Object.is equality
      - Expected
      + Received
      - 409
      + 200
       ❯ tests/agent-id-collision.test.ts:130:25

       Test Files  1 failed (1)
            Tests  1 failed | 1 passed (2)

      This failure proves the new production code rejects the old-semantics
      assertion. Fix in GREEN: change the assertion to expect 200.
      ```
  - [x] **INTEGRATION-GREEN:** Rework the existing tests so the collision triggers on **different Authorization header**, not on "different socket".  Add at least one assertion that two socket paths with same token do NOT collide.  Keep any scenarios that test session-id hijack semantics (now framed as credential hijack).
  - [x] **Verify INTEGRATION-GREEN:** Re-run target + full suite, both green
    - Command: `pnpm exec vitest run tests/agent-id-collision.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      Target:
       ✓ tests/agent-id-collision.test.ts > agent_id collision (credential-based) > different Authorization header presenting same session id returns collision
       ✓ tests/agent-id-collision.test.ts > agent_id collision (credential-based) > same Authorization re-registering across two TCP sockets is ok

       Test Files  1 passed (1)
            Tests  2 passed (2)

      Full suite:
       Test Files  50 passed (50)
            Tests  118 passed (118)
         Duration  3.45s
      ```
  - [x] **REFACTOR:** None — aligning pre-existing tests is a rewrite, not a refactor.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/agent-id-collision.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      None — no refactor applied (per task description "aligning pre-existing tests is a rewrite, not a refactor").
      Re-running target for green-after-no-change confirmation:
       ✓ tests/agent-id-collision.test.ts > agent_id collision (credential-based) > different Authorization header presenting same session id returns collision
       ✓ tests/agent-id-collision.test.ts > agent_id collision (credential-based) > same Authorization re-registering across two TCP sockets is ok
       Test Files  1 passed (1)
            Tests  2 passed (2)
      ```
  - [x] **Commit:** `test(transport): rewrite pre-existing collision tests to auth-hash semantics`
    - **Commit SHA (fill during apply):** `977f459`

## Scenario Coverage Matrix

| Spec scenario | Test file | Task |
|---|---|---|
| `Different Authorization credentials on same session id in token mode` | `tests/agent-id-collision-auth-hash.test.ts` + `tests/agent-id-collision.test.ts` | 1.1, 2.1 |
| `Same Authorization across different TCP sockets accepted` | `tests/agent-id-collision-auth-hash.test.ts` | 1.1 |
| `No-token mode never triggers agent_id_collision` | `tests/agent-id-collision-auth-hash.test.ts` | 1.1 |

Total unique spec scenarios: 3.  Total top-level tasks: 2.  Every scenario has at least one task-level test assertion.
