# Implementation Tasks — add-poke-mcp-tool

Ordered by dependency: tmux-cli wrapper (1) → poke validation (2) → poke tool registration and integration (3) → tmux-path integration (4) → docs (5).  Each code task follows RED → GREEN → REFACTOR.  Docs is manual-verify.

## 1. Tmux CLI wrapper module

- [x] 1.1 Create `src/daemon/tmux-cli.ts` exposing `isTmuxAvailable`, `capturePaneTail`, `loadBuffer`, `pasteBuffer`, `sendEnter` using `child_process.execFile`
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `Daemon issues tmux commands without shell`
  - **Files:**
    - Create: `src/daemon/tmux-cli.ts`
    - Create: `tests/tmux-cli.test.ts`
  - [x] **RED:** Write failing test asserting each helper is a function and `execFile` is called with parsed argv array (not a shell command string).  Mock `child_process.execFile` via `vi.mock('node:child_process')`:
    ```ts
    import { describe, it, expect, vi, beforeEach } from 'vitest'
    import * as cp from 'node:child_process'
    vi.mock('node:child_process', () => ({ execFile: vi.fn() }))

    describe('tmux-cli wrappers', () => {
      beforeEach(() => vi.clearAllMocks())

      it('isTmuxAvailable returns true when tmux -V exits 0', async () => {
        const { isTmuxAvailable } = await import('../src/daemon/tmux-cli.js')
        ;(cp.execFile as any).mockImplementation((_cmd: string, _args: string[], cb: any) => cb(null, { stdout: 'tmux 3.4\n', stderr: '' }))
        expect(await isTmuxAvailable()).toBe(true)
        expect(cp.execFile).toHaveBeenCalledWith('tmux', ['-V'], expect.anything())
      })

      it('capturePaneTail invokes tmux capture-pane with -t/-p/-S args', async () => {
        const { capturePaneTail } = await import('../src/daemon/tmux-cli.js')
        ;(cp.execFile as any).mockImplementation((_cmd: string, _args: string[], cb: any) => cb(null, { stdout: 'line1\nline2\n', stderr: '' }))
        const tail = await capturePaneTail('%42', 8)
        expect(tail).toContain('line1')
        const args = (cp.execFile as any).mock.calls[0][1]
        expect(args).toEqual(['capture-pane', '-t', '%42', '-p', '-S', '-8'])
      })

      it('loadBuffer sends prompt bytes via stdin (not argv)', async () => {
        const { loadBuffer } = await import('../src/daemon/tmux-cli.js')
        const written: Buffer[] = []
        const fakeChild = { stdin: { write: (b: Buffer) => written.push(b), end: vi.fn() }, on: vi.fn((evt: string, cb: any) => { if (evt === 'close') setImmediate(() => cb(0)) }) }
        const spawnSpy = vi.spyOn(cp, 'spawn').mockReturnValue(fakeChild as any)
        await loadBuffer('poke-abc', 'hello 世界')
        expect(spawnSpy).toHaveBeenCalledWith('tmux', ['load-buffer', '-b', 'poke-abc', '-'])
        expect(Buffer.concat(written).toString('utf8')).toBe('hello 世界')
      })

      it('pasteBuffer uses bracketed paste and delete-after', async () => {
        const { pasteBuffer } = await import('../src/daemon/tmux-cli.js')
        ;(cp.execFile as any).mockImplementation((_cmd: string, _args: string[], cb: any) => cb(null, { stdout: '', stderr: '' }))
        await pasteBuffer('poke-abc', '%42')
        const args = (cp.execFile as any).mock.calls[0][1]
        expect(args).toEqual(['paste-buffer', '-b', 'poke-abc', '-t', '%42', '-p', '-d'])
      })

      it('sendEnter sends only the Enter key', async () => {
        const { sendEnter } = await import('../src/daemon/tmux-cli.js')
        ;(cp.execFile as any).mockImplementation((_cmd: string, _args: string[], cb: any) => cb(null, { stdout: '', stderr: '' }))
        await sendEnter('%42')
        const args = (cp.execFile as any).mock.calls[0][1]
        expect(args).toEqual(['send-keys', '-t', '%42', 'Enter'])
      })
    })
    ```
  - [x] **Verify RED:** Run test, confirm failure because `src/daemon/tmux-cli.ts` does not exist
    - Command: `pnpm exec vitest run tests/tmux-cli.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      × tests/tmux-cli.test.ts > tmux-cli wrappers > isTmuxAvailable returns true when tmux -V exits 0
        → Failed to load url ../src/daemon/tmux-cli.js (resolved id: ../src/daemon/tmux-cli.js) in /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec/tests/tmux-cli.test.ts. Does the file exist?
      × tests/tmux-cli.test.ts > tmux-cli wrappers > capturePaneTail invokes tmux capture-pane with -t/-p/-S args
      × tests/tmux-cli.test.ts > tmux-cli wrappers > loadBuffer sends prompt bytes via stdin (not argv)
      × tests/tmux-cli.test.ts > tmux-cli wrappers > pasteBuffer uses bracketed paste and delete-after
      × tests/tmux-cli.test.ts > tmux-cli wrappers > sendEnter sends only the Enter key
       Test Files  1 failed (1)
            Tests  5 failed (5)
      ```
  - [x] **GREEN:** Implement `src/daemon/tmux-cli.ts`:
    ```ts
    import { execFile, spawn } from 'node:child_process'
    import { promisify } from 'node:util'

    const pExecFile = promisify(execFile)

    let _isTmuxAvailable: boolean | null = null

    export async function isTmuxAvailable(): Promise<boolean> {
      if (_isTmuxAvailable !== null) return _isTmuxAvailable
      try { await pExecFile('tmux', ['-V']); _isTmuxAvailable = true }
      catch { _isTmuxAvailable = false }
      return _isTmuxAvailable
    }

    export async function capturePaneTail(paneId: string, lines = 8): Promise<string> {
      const { stdout } = await pExecFile('tmux', ['capture-pane', '-t', paneId, '-p', '-S', `-${lines}`])
      return stdout
    }

    export function loadBuffer(bufferName: string, prompt: string): Promise<void> {
      return new Promise((resolve, reject) => {
        const child = spawn('tmux', ['load-buffer', '-b', bufferName, '-'])
        child.on('error', reject)
        child.on('close', code => code === 0 ? resolve() : reject(new Error(`load-buffer exit ${code}`)))
        child.stdin.write(Buffer.from(prompt, 'utf8'))
        child.stdin.end()
      })
    }

    export async function pasteBuffer(bufferName: string, paneId: string): Promise<void> {
      await pExecFile('tmux', ['paste-buffer', '-b', bufferName, '-t', paneId, '-p', '-d'])
    }

    export async function sendEnter(paneId: string): Promise<void> {
      await pExecFile('tmux', ['send-keys', '-t', paneId, 'Enter'])
    }

    // test helper only
    export function _resetTmuxAvailableCache(): void { _isTmuxAvailable = null }
    ```
  - [x] **Verify GREEN:** Re-run test + full suite
    - Command: `pnpm exec vitest run tests/tmux-cli.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      Target test:
       ✓ tests/tmux-cli.test.ts > tmux-cli wrappers > isTmuxAvailable returns true when tmux -V exits 0
       ✓ tests/tmux-cli.test.ts > tmux-cli wrappers > capturePaneTail invokes tmux capture-pane with -t/-p/-S args
       ✓ tests/tmux-cli.test.ts > tmux-cli wrappers > loadBuffer sends prompt bytes via stdin (not argv)
       ✓ tests/tmux-cli.test.ts > tmux-cli wrappers > pasteBuffer uses bracketed paste and delete-after
       ✓ tests/tmux-cli.test.ts > tmux-cli wrappers > sendEnter sends only the Enter key
       Test Files  1 passed (1)
            Tests  5 passed (5)
      Full suite:
       Test Files  44 passed (44)
            Tests  104 passed (104)
      ```
  - [x] **REFACTOR:** Confirm no helper runs a shell; confirm `loadBuffer` uses spawn-stdin.  None else.
  - [x] **Verify REFACTOR:** Re-run tests
    - Command: `pnpm exec vitest run tests/tmux-cli.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       Test Files  1 passed (1)
            Tests  5 passed (5)
      (No behavioral changes; helpers use execFile/spawn with argv arrays only; loadBuffer feeds prompt via stdin.)
      ```
  - [x] **Commit:** `feat(daemon): add tmux-cli wrapper using execFile/spawn`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `71dd5cd`

## 2. poke business validation (pre-tmux checks)

- [x] 2.1 `poke` rejects unregistered caller → `{ error: 'unknown_agent' }`
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `Unregistered session rejected with unknown_agent`
  - **Files:**
    - Create: `src/mcp/poke.ts`
    - Create: `tests/poke-validation.test.ts`
    - Edit: `src/mcp/tools.ts` (register `poke` tool; tests/import will drive this)
  - [x] **RED:** Start `tests/poke-validation.test.ts` with a freshDaemon helper that starts daemon, gets an MCP client, and for this first test does NOT call register_agent:
    ```ts
    import { describe, it, expect, afterEach } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { Client } from '@modelcontextprotocol/sdk/client/index.js'
    import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
    import { startServer } from '../src/daemon/server.js'

    const tmp = () => mkdtempSync(join(tmpdir(), 'atm-poke-'))

    describe('poke validation', () => {
      const cleanups: string[] = []
      afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

      it('returns unknown_agent if caller has not registered', async () => {
        const dir = tmp(); cleanups.push(dir)
        const { app, port } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
        const url = new URL(`http://127.0.0.1:${port}/mcp`)
        const t = new StreamableHTTPClientTransport(url)
        const c = new Client({ name: 'test', version: '0.0.0' })
        await c.connect(t)

        const resp = await c.callTool({ name: 'poke', arguments: { target_agent_id: 'any', prompt: 'p' } })
        const obj = JSON.parse((resp.content as Array<{ text: string }>)[0].text)
        expect(obj).toEqual({ error: 'unknown_agent' })

        await t.terminateSession(); await app.close()
      })
    })
    ```
  - [x] **Verify RED:** Fails because `poke` tool not registered yet
    - Command: `pnpm exec vitest run tests/poke-validation.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      × tests/poke-validation.test.ts > poke validation > returns unknown_agent if caller has not registered
        → Unexpected token 'M', "MCP error "... is not valid JSON
      SyntaxError: Unexpected token 'M', "MCP error "... is not valid JSON
       Test Files  1 failed (1)
            Tests  1 failed (1)
      ```
  - [x] **GREEN:** Create `src/mcp/poke.ts` with the service skeleton that only handles unknown_agent for now; wire it in `src/mcp/tools.ts`:
    ```ts
    // src/mcp/poke.ts (skeleton)
    import type Database from 'better-sqlite3'
    export interface PokeDeps { db: Database.Database; callerAgentId: string | null }
    export interface PokeInput { target_agent_id: string; prompt: string }
    export type PokeResult =
      | { ok: true; pane_id: string; pane_tail_before: string; pane_tail_after: string }
      | { error: string; detail?: unknown }

    export async function poke(deps: PokeDeps, input: PokeInput): Promise<PokeResult> {
      if (!deps.callerAgentId) return { error: 'unknown_agent' }
      // further checks added in later tasks
      return { error: 'unknown_target' }
    }
    ```
    In `src/mcp/tools.ts` add registration:
    ```ts
    import { poke } from './poke.js'
    // ...
    server.registerTool('poke', {
      title: 'Poke agent', description: 'Wake another agent in the same team by injecting prompt into its tmux pane. Returns pre/post pane capture tails. Soft recommendation: retry at most 3 times per target per short window.',
      inputSchema: { target_agent_id: z.string(), prompt: z.string() }
    }, async (args) => {
      const callerAgentId = caller()
      return toText(await poke({ db, callerAgentId }, args))
    })
    ```
  - [x] **Verify GREEN:** Run test
    - Command: `pnpm exec vitest run tests/poke-validation.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/poke-validation.test.ts > poke validation > returns unknown_agent if caller has not registered
       Test Files  1 passed (1)
            Tests  1 passed (1)
      Full suite:
       Test Files  45 passed (45)
            Tests  105 passed (105)
      ```
  - [x] **REFACTOR:** None yet (stub).  Will grow in subsequent tasks.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/poke-validation.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/poke-validation.test.ts > poke validation > returns unknown_agent if caller has not registered
       Test Files  1 passed (1)
            Tests  1 passed (1)
      (REFACTOR is None — already minimal.)
      ```
  - [x] **Commit:** `feat(mcp): register poke tool with unknown_agent guard`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `a7e8020`

- [x] 2.2 `poke` rejects unknown `target_agent_id` → `{ error: 'unknown_target' }`
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `Target not in agents table`
  - **Files:**
    - Edit: `tests/poke-validation.test.ts`
    - Edit: `src/mcp/poke.ts`
  - [x] **RED:** Add test case (caller registers, then pokes a ghost id)
    ```ts
    it('returns unknown_target when target_agent_id does not exist', async () => {
      // ...register caller, then call poke with target_agent_id: 'ghost'...
      expect(obj).toEqual({ error: 'unknown_target' })
    })
    ```
  - [x] **Verify RED:** Skeleton from 2.1 already returns unknown_target for any input after register, so this case passes on first run — as the task description itself notes.  The real safety net is task 2.3/2.4/2.5 which force the code to split unknown_target from later checks.
    - Command: `pnpm exec vitest run tests/poke-validation.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/poke-validation.test.ts > poke validation > returns unknown_agent if caller has not registered
       ✓ tests/poke-validation.test.ts > poke validation > returns unknown_target when target_agent_id does not exist
       Test Files  1 passed (1)
            Tests  2 passed (2)
      (Note: skeleton already returned unknown_target unconditionally — this scenario documents the path; the real DB lookup is enforced below so subsequent tasks 2.3-2.5 can progress.)
      ```
  - [x] **GREEN:** In `poke.ts`, query `SELECT agent_id, team, tmux_pane_id FROM agents WHERE agent_id = ?`; if undefined return `unknown_target`; placeholder `return { error: 'tmux_pane_not_set' }` for the null case (next task will test-drive this); trailing branch returns `tmux_cmd_failed` placeholder
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/poke-validation.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/poke-validation.test.ts > poke validation > returns unknown_agent if caller has not registered
       ✓ tests/poke-validation.test.ts > poke validation > returns unknown_target when target_agent_id does not exist
       Test Files  1 passed (1)
            Tests  2 passed (2)
      ```
  - [x] **REFACTOR:** None
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/poke-validation.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       Test Files  1 passed (1)
            Tests  2 passed (2)
      (REFACTOR is None — already minimal.)
      ```
  - [x] **Commit:** `feat(poke): add unknown_target check`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `442a516`

- [x] 2.3 `poke` rejects target without `tmux_pane_id` → `{ error: 'tmux_pane_not_set' }`
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `Target never registered pane id`
  - **Files:**
    - Edit: `tests/poke-validation.test.ts`
    - Edit: `src/mcp/poke.ts`
  - [x] **RED:** Register two agents (caller and target), target without tmux_pane_id; expect `{error:'tmux_pane_not_set'}`
  - [x] **Verify RED:** Covered by placeholder return from task 2.2 — passes immediately as documented by the task.  Observed output below confirms the branch.
    - Command: `pnpm exec vitest run tests/poke-validation.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/poke-validation.test.ts > poke validation > returns unknown_agent if caller has not registered
       ✓ tests/poke-validation.test.ts > poke validation > returns unknown_target when target_agent_id does not exist
       ✓ tests/poke-validation.test.ts > poke validation > returns tmux_pane_not_set when target has no tmux_pane_id
       Test Files  1 passed (1)
            Tests  3 passed (3)
      ```
  - [x] **GREEN:** Confirm poke.ts returns `tmux_pane_not_set` when `tmux_pane_id IS NULL` or empty-string (existing code already does).  No new changes.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/poke-validation.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       Test Files  1 passed (1)
            Tests  3 passed (3)
      ```
  - [x] **REFACTOR:** None
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/poke-validation.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       Test Files  1 passed (1)
            Tests  3 passed (3)
      (REFACTOR is None — already minimal.)
      ```
  - [x] **Commit:** `feat(poke): add tmux_pane_not_set check`
    - **Commit SHA (fill during apply):** `bda8b40`

- [x] 2.4 `poke` rejects self-poke → `{ error: 'self_poke_denied' }`
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `Caller pokes self`
  - **Files:**
    - Edit: `tests/poke-validation.test.ts`
    - Edit: `src/mcp/poke.ts`
  - [x] **RED:** Register one agent (with tmux_pane_id='%1'); have it call poke with its own agent_id
  - [x] **Verify RED:** Fails because existing code hits placeholder `tmux_cmd_failed` — must assert strict `self_poke_denied` enforcement
    - Command: `pnpm exec vitest run tests/poke-validation.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      AssertionError: expected { error: 'tmux_cmd_failed' } to deeply equal { error: 'self_poke_denied' }
        Object {
      -   "error": "self_poke_denied",
      +   "error": "tmux_cmd_failed",
        }
       ❯ tests/poke-validation.test.ts:77:17
       Test Files  1 failed (1)
            Tests  1 failed | 3 passed (4)
      ```
  - [x] **GREEN:** In poke.ts, immediately after loading target row, if `target.agent_id === deps.callerAgentId` return `{error:'self_poke_denied'}`.  This check must precede tmux_pane_not_set and cross_team checks.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/poke-validation.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/poke-validation.test.ts > poke validation > returns unknown_agent if caller has not registered
       ✓ tests/poke-validation.test.ts > poke validation > returns unknown_target when target_agent_id does not exist
       ✓ tests/poke-validation.test.ts > poke validation > returns self_poke_denied when caller pokes itself
       ✓ tests/poke-validation.test.ts > poke validation > returns tmux_pane_not_set when target has no tmux_pane_id
       Test Files  1 passed (1)
            Tests  4 passed (4)
      ```
  - [x] **REFACTOR:** None
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/poke-validation.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       Test Files  1 passed (1)
            Tests  4 passed (4)
      (REFACTOR is None — already minimal.)
      ```
  - [x] **Commit:** `feat(poke): add self_poke_denied check`
    - **Commit SHA (fill during apply):** `e8130c5`

- [x] 2.5 `poke` rejects cross-team → `{ error: 'cross_team_denied' }`
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `Cross-team target`
  - **Files:**
    - Edit: `tests/poke-validation.test.ts`
    - Edit: `src/mcp/poke.ts`
  - [x] **RED:** Register caller in team `alpha`, target in team `beta` (with tmux_pane_id set); expect `{error:'cross_team_denied'}`
  - [x] **Verify RED:** Fails as current poke would proceed past team check
    - Command: `pnpm exec vitest run tests/poke-validation.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      AssertionError: expected { error: 'tmux_cmd_failed' } to deeply equal { error: 'cross_team_denied' }
        Object {
      -   "error": "cross_team_denied",
      +   "error": "tmux_cmd_failed",
        }
       ❯ tests/poke-validation.test.ts:111:17
       Test Files  1 failed (1)
            Tests  1 failed | 4 passed (5)
      ```
  - [x] **GREEN:** Load caller's team via `SELECT team FROM agents WHERE agent_id=?`; compare with target.team; if not equal return `{error:'cross_team_denied'}`
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/poke-validation.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/poke-validation.test.ts > poke validation > returns unknown_agent if caller has not registered
       ✓ tests/poke-validation.test.ts > poke validation > returns unknown_target when target_agent_id does not exist
       ✓ tests/poke-validation.test.ts > poke validation > returns self_poke_denied when caller pokes itself
       ✓ tests/poke-validation.test.ts > poke validation > returns tmux_pane_not_set when target has no tmux_pane_id
       ✓ tests/poke-validation.test.ts > poke validation > returns cross_team_denied when caller and target are in different teams
       Test Files  1 passed (1)
            Tests  5 passed (5)
      ```
  - [x] **REFACTOR:** None
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/poke-validation.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       Test Files  1 passed (1)
            Tests  5 passed (5)
      (REFACTOR is None — already minimal.)
      ```
  - [x] **Commit:** `feat(poke): add cross_team_denied check`
    - **Commit SHA (fill during apply):** `7c6bcf6`

- [x] 2.6 `poke` rejects prompt > 8KB → `{ error: 'prompt_too_long', detail: { max: 8192, got: N } }`
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `10 KB prompt rejected before any tmux action`
  - **Files:**
    - Edit: `tests/poke-validation.test.ts`
    - Edit: `src/mcp/poke.ts`
  - [x] **RED:** Register caller + valid target, call poke with `'a'.repeat(10240)`; expect structured error
  - [x] **Verify RED:** Fails because current poke ignores prompt length
    - Command: `pnpm exec vitest run tests/poke-validation.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      AssertionError: expected { error: 'tmux_cmd_failed' } to deeply equal …
        Object {
      -   "detail": Object {
      -     "got": 10240,
      -     "max": 8192,
      -   },
      -   "error": "prompt_too_long",
      +   "error": "tmux_cmd_failed",
        }
       ❯ tests/poke-validation.test.ts:112:17
       Test Files  1 failed (1)
            Tests  1 failed | 5 passed (6)
      ```
  - [x] **GREEN:** At the very top of poke (after unknown_agent), `const len = Buffer.byteLength(input.prompt, 'utf8'); if (len > PROMPT_MAX_BYTES) return { error:'prompt_too_long', detail:{ max: PROMPT_MAX_BYTES, got: len } }`.  The constant `PROMPT_MAX_BYTES = 8192` is exported from `poke.ts`.  Position deliberately before target lookup so the tmux infrastructure is never touched.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/poke-validation.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/poke-validation.test.ts > poke validation > returns prompt_too_long when prompt byte length exceeds 8192
       Test Files  1 passed (1)
            Tests  6 passed (6)
      Full suite:
       Test Files  45 passed (45)
            Tests  110 passed (110)
      ```
  - [x] **REFACTOR:** None
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/poke-validation.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       Test Files  1 passed (1)
            Tests  6 passed (6)
      (REFACTOR is None — already minimal.)
      ```
  - [x] **Commit:** `feat(poke): enforce 8KB prompt cap`
    - **Commit SHA (fill during apply):** `b78efe5`

## 3. poke MCP tool registration on the wire

- [x] 3.1 `poke` tool appears in `tools/list` response
  - kind: integration-test
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `poke appears in list_tools`
  - **Files:**
    - Create: `tests/poke-tool-registration.test.ts`
  - [x] **INTEGRATION-RED:** Bring up real daemon + real MCP Client, call `client.listTools()`, assert a tool named `poke` with the declared input schema
  - [x] **Verify INTEGRATION-RED:** As the task states: since 2.1 already registered the tool, the assertion passes on first run.  This integration test formalises the guard against future regression where registration disappears.
    - Command: `pnpm exec vitest run tests/poke-tool-registration.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/poke-tool-registration.test.ts > poke tool registration > poke tool is registered with target_agent_id and prompt in inputSchema
       Test Files  1 passed (1)
            Tests  1 passed (1)
      (Expected pass — tool was registered in task 2.1; this file pins the invariant for regression protection.)
      ```
  - [x] **INTEGRATION-GREEN:** Nothing to add (achieved by 2.1)
  - [x] **Verify INTEGRATION-GREEN:**
    - Command: `pnpm exec vitest run tests/poke-tool-registration.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/poke-tool-registration.test.ts > poke tool registration > poke tool is registered with target_agent_id and prompt in inputSchema
       Test Files  1 passed (1)
            Tests  1 passed (1)
      ```
  - [x] **REFACTOR:** None
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/poke-tool-registration.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       Test Files  1 passed (1)
            Tests  1 passed (1)
      (REFACTOR is None — already minimal.)
      ```
  - [x] **Commit:** `test(poke): registration surfaces on tools/list`
    - **Commit SHA (fill during apply):** `eae9bf1`

## 4. poke tmux-path integration

- [x] 4.1 Happy path — real tmux, target is a live scratch pane, before/after tails returned
  - kind: integration-test
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `Happy path returns before/after tails`
  - **Files:**
    - Create: `tests/poke-e2e.test.ts`
    - Edit: `src/mcp/poke.ts` (wire tmux-cli + orchestrate the 7-step sequence)
  - [x] **INTEGRATION-RED:** Test bootstraps a tmux session (in a sandbox prefix, e.g. `atm-test-<pid>`) spawning `cat` in the one pane, reads that pane's `#{pane_id}`, registers two agents, and calls poke; asserts `ok`, `pane_id` matches, and tails are strings.  Skip if `isTmuxAvailable()` is false.
    ```ts
    import { execFileSync } from 'node:child_process'
    import { isTmuxAvailable } from '../src/daemon/tmux-cli.js'
    // ... inside test:
    if (!(await isTmuxAvailable())) return // skip — expressed via .skipIf or early return + console.warn
    const session = `atm-test-${process.pid}`
    execFileSync('tmux', ['new-session', '-d', '-s', session, 'cat'])
    const paneId = execFileSync('tmux', ['list-panes', '-t', session, '-F', '#{pane_id}']).toString().trim()
    try {
      // ...register caller + target (target with tmux_pane_id=paneId), call poke...
      expect(obj.ok).toBe(true)
      expect(obj.pane_id).toBe(paneId)
      expect(typeof obj.pane_tail_before).toBe('string')
      expect(typeof obj.pane_tail_after).toBe('string')
    } finally {
      execFileSync('tmux', ['kill-session', '-t', session])
    }
    ```
  - [x] **Verify INTEGRATION-RED:** Fails because poke.ts still returns error after validation (tmux orchestration missing)
    - Command: `pnpm exec vitest run tests/poke-e2e.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      AssertionError: expected undefined to be true
      - Expected: true
      + Received: undefined
       ❯ tests/poke-e2e.test.ts:64:22
           62|       const resp = await A.c.callTool({ name: 'poke', arguments: { ...
           63|       const obj = await parseTool(resp)
           64|       expect(obj.ok).toBe(true)
       Test Files  1 failed (1)
            Tests  1 failed (1)
      ```
  - [x] **INTEGRATION-GREEN:** Implement 7-step sequence in poke.ts using tmux-cli:
    ```ts
    // pseudocode inside poke() after all validation passes and target.tmux_pane_id is set:
    if (!(await isTmuxAvailable())) return { error: 'tmux_unavailable' }
    const paneId = target.tmux_pane_id!
    const bufName = `poke-${randomBytes(3).toString('hex')}`
    try {
      const pane_tail_before = await capturePaneTail(paneId, 8)
      await loadBuffer(bufName, input.prompt)
      await pasteBuffer(bufName, paneId)
      await delay(400)
      await sendEnter(paneId)
      await delay(400)
      const pane_tail_after = await capturePaneTail(paneId, 8)
      return { ok: true, pane_id: paneId, pane_tail_before, pane_tail_after }
    } catch (e) {
      const { kind, detail } = classifyTmuxError(e)
      return { error: kind, detail }
    }
    ```
  - [x] **Verify INTEGRATION-GREEN:** Run test + full suite; confirm green on machines with tmux, skip on machines without
    - Command: `pnpm exec vitest run tests/poke-e2e.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/poke-e2e.test.ts > poke e2e (real tmux) > happy path: poke returns before/after tails for live pane 1038ms
       Test Files  1 passed (1)
            Tests  1 passed (1)
      Full suite:
       Test Files  47 passed (47)
            Tests  112 passed (112)
      ```
  - [x] **REFACTOR:** Extracted `classifyTmuxError` helper and `runStage` wrapper so stage information is preserved on failure.  Named constants `PROMPT_MAX_BYTES`, `PASTE_SETTLE_MS`, `TAIL_LINES` instead of magic numbers.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/poke-e2e.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/poke-e2e.test.ts > poke e2e (real tmux) > happy path: poke returns before/after tails for live pane 1038ms
       Test Files  1 passed (1)
            Tests  1 passed (1)
      ```
  - [x] **Commit:** `feat(poke): orchestrate tmux capture/paste-buffer/send-keys for happy path`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `da65723`

- [x] 4.2 `tmux_unavailable` returned when tmux binary missing
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `No tmux binary on PATH`
  - **Files:**
    - Create: `tests/poke-tmux-unavailable.test.ts`
    - Edit: `src/daemon/tmux-cli.ts` (export `_setTmuxAvailableForTest`)
  - [x] **RED:** Force `_setTmuxAvailableForTest(false)` and call poke with otherwise valid inputs; expect `{error:'tmux_unavailable', detail:<string>}`
  - [x] **Verify RED:** Task 4.1 already landed both the `isTmuxAvailable()` guard in poke.ts and the `_setTmuxAvailableForTest` hook in tmux-cli.ts — so this targeted test passes on first run.  It locks in the contract for future regressions.
    - Command: `pnpm exec vitest run tests/poke-tmux-unavailable.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/poke-tmux-unavailable.test.ts > poke tmux_unavailable > returns tmux_unavailable when tmux binary is not available
       Test Files  1 passed (1)
            Tests  1 passed (1)
      (Expected pass — 4.1 already wired the guard; this test locks the contract against regressions.)
      ```
  - [x] **GREEN:** Already covered by task 4.1's `if (!isTmuxAvailable())` guard plus a test hook in tmux-cli.ts to force-set cache
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/poke-tmux-unavailable.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/poke-tmux-unavailable.test.ts > poke tmux_unavailable > returns tmux_unavailable when tmux binary is not available
       Test Files  1 passed (1)
            Tests  1 passed (1)
      ```
  - [x] **REFACTOR:** None
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/poke-tmux-unavailable.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       Test Files  1 passed (1)
            Tests  1 passed (1)
      (REFACTOR is None — already minimal.)
      ```
  - [x] **Commit:** `test(poke): tmux_unavailable path via cache hook`
    - **Commit SHA (fill during apply):** `17421dd`

- [x] 4.3 `pane_dead` returned when target pane was killed after registration
  - kind: integration-test
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `Target pane was killed after registration`
  - **Files:**
    - Edit: `tests/poke-e2e.test.ts`
    - Edit: `src/mcp/poke.ts` (classifyTmuxError → pane_dead)
  - [x] **INTEGRATION-RED:** Create a tmux session, grab pane_id, register agents with that pane, kill the session, then call poke; expect `{error:'pane_dead', detail:<string>}`
  - [x] **Verify INTEGRATION-RED:** Task 4.1's REFACTOR already extracted `classifyTmuxError` with the `can't find pane` / `pane not found` / `no such pane` recognition, so this test passes on first run.  The assertion locks the contract.
    - Command: `pnpm exec vitest run tests/poke-e2e.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/poke-e2e.test.ts > poke e2e (real tmux) > returns pane_dead when target pane was killed after registration
       ✓ tests/poke-e2e.test.ts > poke e2e (real tmux) > happy path: poke returns before/after tails for live pane 984ms
       Test Files  1 passed (1)
            Tests  2 passed (2)
      (Expected pass — classifier was staged during 4.1 REFACTOR; this test pins the behavior.)
      ```
  - [x] **INTEGRATION-GREEN:** In `classifyTmuxError`, inspect stderr for tokens like `can't find pane`, `pane not found`, or `no such pane`; map to `pane_dead`
  - [x] **Verify INTEGRATION-GREEN:**
    - Command: `pnpm exec vitest run tests/poke-e2e.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/poke-e2e.test.ts > poke e2e (real tmux) > returns pane_dead when target pane was killed after registration
       ✓ tests/poke-e2e.test.ts > poke e2e (real tmux) > happy path: poke returns before/after tails for live pane 984ms
       Test Files  1 passed (1)
            Tests  2 passed (2)
      ```
  - [x] **REFACTOR:** None
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/poke-e2e.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       Test Files  1 passed (1)
            Tests  2 passed (2)
      (REFACTOR is None — already minimal.)
      ```
  - [x] **Commit:** `feat(poke): classify pane_dead from tmux stderr`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `5b9118a`

- [x] 4.4 `tmux_cmd_failed` returned with stage info for unexpected tmux errors
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `load-buffer fails unexpectedly`
  - **Files:**
    - Create: `tests/poke-tmux-cmd-failed.test.ts`
    - Edit: `src/mcp/poke.ts` (classifyTmuxError)
  - [x] **RED:** Mock tmux-cli so `loadBuffer` rejects with a made-up Error('unexpected-x'); call poke; expect `{error:'tmux_cmd_failed', detail:{stage:'load_buffer', stderr:<string>}}`
  - [x] **Verify RED:** Task 4.1's REFACTOR already introduced the `runStage` wrapper + `classifyTmuxError` fallback that maps unknown failures to `tmux_cmd_failed` with stage info — so this test passes on first run.  It locks the contract.
    - Command: `pnpm exec vitest run tests/poke-tmux-cmd-failed.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/poke-tmux-cmd-failed.test.ts > poke tmux_cmd_failed with stage info > returns tmux_cmd_failed with stage "load_buffer" when loadBuffer rejects unexpectedly
       Test Files  1 passed (1)
            Tests  1 passed (1)
      (Expected pass — `runStage` wrapper and classifier were staged during 4.1 REFACTOR; this test pins the stage-label contract.)
      ```
  - [x] **GREEN:** Wrap each tmux-cli call with a stage label; catch + rethrow with `{stage, err}` context; `classifyTmuxError` consumes it.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/poke-tmux-cmd-failed.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       ✓ tests/poke-tmux-cmd-failed.test.ts > poke tmux_cmd_failed with stage info > returns tmux_cmd_failed with stage "load_buffer" when loadBuffer rejects unexpectedly
       Test Files  1 passed (1)
            Tests  1 passed (1)
      Full suite:
       Test Files  49 passed (49)
            Tests  115 passed (115)
      ```
  - [x] **REFACTOR:** None
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/poke-tmux-cmd-failed.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       Test Files  1 passed (1)
            Tests  1 passed (1)
      (REFACTOR is None — already minimal.)
      ```
  - [x] **Commit:** `feat(poke): surface tmux_cmd_failed with stage label`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `daa70b0`

## 5. Docs

- [x] 5.1 Update `docs/configs/README.md` with a "Cross-agent poke scenario" section
  - kind: manual-verify
  - **Spec scenario(s):** n/a (documentation-only)
  - **Files:**
    - Edit: `docs/configs/README.md`
  - [x] **IMPLEMENT:** Append a section like:
    ```markdown
    ## Cross-agent poke scenario (Change `add-poke-mcp-tool`)

    After both agents have registered with `tmux_pane_id`:

    1. Agent A calls `poke({ target_agent_id: "<B>", prompt: "new events waiting, please check" })`
    2. Daemon captures B's pane tail, injects the prompt via bracketed paste, sends Enter, captures again
    3. A receives `{ ok, pane_id, pane_tail_before, pane_tail_after }` and inspects the diff to decide whether B acknowledged
    4. If no visible change, A may call `poke` again (soft limit: 3 times per short window)
    5. If still silent, fall back to `send_message` (mailbox persistence) or escalate to the human
    ```
  - [x] **MANUAL-VERIFY:** user reviewed wording via AskUserQuestion at driver (main-agent) scope after the subagent's apply phase deferred
    - Resolved via driver-level AskUserQuestion (apply-fixup path, mirrors add-agent-tmux-pane-id precedent)
    - **Evidence (fill during apply):**
      ```
      Q: Task 5.1 manual-verify: docs/configs/README.md 新增 "Cross-agent poke scenario" 一节如上 (uncommitted 在 working tree), 接受吗?
      A: 接受 (user option: "接受 (Recommended)")
      Interpretation: wording/placement accepted; 5-step walkthrough (send → daemon orchestrate → inspect diff → retry soft cap → fall back to send_message) matches the M1 分离 design and cites soft retry limit per the tool description. Docs committed below.
      ```
  - [x] **Commit:** `docs(configs): add cross-agent poke scenario walkthrough`
    - **Commit SHA (fill during apply):** `cf24d1e`

## Scenario Coverage Matrix

| Spec scenario | Test file | Task |
|---|---|---|
| `poke appears in list_tools` | `tests/poke-tool-registration.test.ts` | 3.1 |
| `Happy path returns before/after tails` | `tests/poke-e2e.test.ts` | 4.1 |
| `Daemon issues tmux commands without shell` | `tests/tmux-cli.test.ts` | 1.1 |
| `Unregistered session rejected with unknown_agent` | `tests/poke-validation.test.ts` | 2.1 |
| `Target not in agents table` | `tests/poke-validation.test.ts` | 2.2 |
| `Target never registered pane id` | `tests/poke-validation.test.ts` | 2.3 |
| `Caller pokes self` | `tests/poke-validation.test.ts` | 2.4 |
| `Cross-team target` | `tests/poke-validation.test.ts` | 2.5 |
| `10 KB prompt rejected before any tmux action` | `tests/poke-validation.test.ts` | 2.6 |
| `No tmux binary on PATH` | `tests/poke-tmux-unavailable.test.ts` | 4.2 |
| `Target pane was killed after registration` | `tests/poke-e2e.test.ts` | 4.3 |
| `load-buffer fails unexpectedly` | `tests/poke-tmux-cmd-failed.test.ts` | 4.4 |

Total unique spec scenarios: 12.  Total top-level tasks: 12 (1.1 + 2.1-2.6 + 3.1 + 4.1-4.4 + 5.1).  Every scenario has at least one task-level test assertion.
