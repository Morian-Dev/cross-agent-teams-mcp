# Tasks

## 1. Core fix

- [x] 1.1 Add `allowCrossTeam` flag to `PokeDeps` and bypass cross-team check when set
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `Cross-team target via MCP tool`
    - `agent-interrupts/spec.md` → Scenario: `Direct MCP poke call with the same cross-team pair still denied`
  - **Files:**
    - Create: `tests/poke-cross-team-allow-flag.test.ts`
    - Modify: `src/mcp/poke.ts`
  - [x] **RED:** Write failing test — `tests/poke-cross-team-allow-flag.test.ts`
    - Behavior under test: `poke({db, callerAgentId, allowCrossTeam: true}, input)` with cross-team caller/target runs past the cross-team check and proceeds to the tmux pipeline; `poke({db, callerAgentId}, input)` without the flag still returns `cross_team_denied`.
    - Expected failure reason: current `src/mcp/poke.ts:94` is `if (callerRow.team !== target.team) return { error: 'cross_team_denied' }` — no flag is consulted, so the `allowCrossTeam:true` branch returns `cross_team_denied` instead of proceeding to tmux.
    ```typescript
    import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { openDb } from '../src/storage/db.js'
    import { applySchema } from '../src/storage/schema.js'

    vi.mock('../src/daemon/tmux-cli.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/daemon/tmux-cli.js')>()
      return {
        ...actual,
        isTmuxAvailable: vi.fn(async () => true),
        capturePaneTail: vi.fn(async () => 'tail'),
        loadBuffer: vi.fn(async () => {}),
        pasteBuffer: vi.fn(async () => {}),
        sendEnter: vi.fn(async () => {})
      }
    })

    import { poke } from '../src/mcp/poke.js'

    const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-poke-xteam-'))

    function seed(db: ReturnType<typeof openDb>, agent_id: string, team: string, name: string, pane: string | null): void {
      const now = new Date().toISOString()
      db.prepare(
        `INSERT INTO agents (agent_id, team, role, name, model, registered_at, last_seen_at, tmux_pane_id)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(agent_id, team, 'r', name, null, now, now, pane)
    }

    describe('poke() cross-team with allowCrossTeam flag', () => {
      const dirs: string[] = []
      afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

      function fresh(): ReturnType<typeof openDb> {
        const dir = tmp(); dirs.push(dir)
        const db = openDb(join(dir, 'data.db'))
        applySchema(db)
        return db
      }

      it('without allowCrossTeam, cross-team caller gets cross_team_denied', async () => {
        const db = fresh()
        seed(db, 'A', 'alpha', 'alice', '%pA')
        seed(db, 'B', 'beta', 'bob', '%pB')
        const res = await poke({ db, callerAgentId: 'A' }, { target_agent_id: 'B', prompt: 'p' })
        expect(res).toEqual({ error: 'cross_team_denied' })
      })

      it('with allowCrossTeam:true, cross-team caller proceeds to tmux pipeline and returns ok', async () => {
        const db = fresh()
        seed(db, 'A', 'alpha', 'alice', '%pA')
        seed(db, 'B', 'beta', 'bob', '%pB')
        const res = await poke(
          { db, callerAgentId: 'A', allowCrossTeam: true },
          { target_agent_id: 'B', prompt: 'p' }
        )
        expect('ok' in res && res.ok).toBe(true)
      })

      it('same-team caller is unaffected by the flag (still ok)', async () => {
        const db = fresh()
        seed(db, 'A', 'alpha', 'alice', '%pA')
        seed(db, 'B', 'alpha', 'bob', '%pB')
        const res = await poke({ db, callerAgentId: 'A' }, { target_agent_id: 'B', prompt: 'p' })
        expect('ok' in res && res.ok).toBe(true)
      })
    })
    ```
  - [x] **Verify RED:** Run test, confirm second assertion fails because current code returns `cross_team_denied` regardless of the flag.
    - Command: `npx vitest run tests/poke-cross-team-allow-flag.test.ts`
    - **Observed output (fill during apply):**
      ```
       ❯ tests/poke-cross-team-allow-flag.test.ts (3 tests | 1 failed) 815ms
         × poke() cross-team with allowCrossTeam flag > with allowCrossTeam:true, cross-team caller proceeds to tmux pipeline and returns ok 4ms
           → expected false to be true // Object.is equality
         ✓ poke() cross-team with allowCrossTeam flag > same-team caller is unaffected by the flag (still ok) 806ms

       FAIL  tests/poke-cross-team-allow-flag.test.ts > poke() cross-team with allowCrossTeam flag > with allowCrossTeam:true, cross-team caller proceeds to tmux pipeline and returns ok
      AssertionError: expected false to be true // Object.is equality
       ❯ tests/poke-cross-team-allow-flag.test.ts:59:35
           57|       { target_agent_id: 'B', prompt: 'p' }
           58|     )
           59|     expect('ok' in res && res.ok).toBe(true)
             |                                   ^
       Test Files  1 failed (1)
            Tests  1 failed | 2 passed (3)
      ```
  - [x] **GREEN:** Modify `src/mcp/poke.ts`:
    ```typescript
    // 1) Extend PokeDeps to accept the optional flag:
    export interface PokeDeps {
      db: Database.Database
      callerAgentId: string | null
      allowCrossTeam?: boolean
    }

    // 2) Change the cross-team guard (currently around line 94) from:
    //      if (callerRow.team !== target.team) return { error: 'cross_team_denied' }
    //    to:
    if (callerRow.team !== target.team && !deps.allowCrossTeam) {
      return { error: 'cross_team_denied' }
    }
    ```
    Do NOT touch other validations (self_poke_denied, tmux_unavailable, tmux_pane_not_set, prompt_too_long).
  - [x] **Verify GREEN:** Targeted test + full suite. Existing `tests/poke-validation.test.ts:119` ("returns cross_team_denied when caller and target are in different teams") MUST still pass because MCP tool entry does not pass the flag.
    - Command: `npx vitest run tests/poke-cross-team-allow-flag.test.ts tests/poke-validation.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      # Targeted:
      ✓ tests/poke-cross-team-allow-flag.test.ts (3 tests) 1615ms
        ✓ without allowCrossTeam, cross-team caller gets cross_team_denied
        ✓ with allowCrossTeam:true, cross-team caller proceeds to tmux pipeline and returns ok 805ms
        ✓ same-team caller is unaffected by the flag (still ok) 808ms
      ❯ tests/poke-validation.test.ts (6 tests | 1 failed) 103ms
        (regression-preserving) ✓ "returns cross_team_denied when caller and target are in different teams" — PASS
        (pre-existing, unrelated) × "returns tmux_pane_not_set when target has no tmux_pane_id" — known baseline failure from tighten-agent-identity (A/B clients collide on session id)

      # Full suite:
       Test Files  3 failed | 76 passed (79)
            Tests  4 failed | 252 passed (256)
      # Baseline (git stash) had 5 failures / 251 passes → after GREEN: 4 failures / 252 passes (net +1 pass from the new test's cross-team allow branch; 4 remaining failures are pre-existing baseline, unrelated to this change).
      ```
  - [x] **REFACTOR:** Add a 1-line English doc comment above the `PokeDeps` interface noting that `allowCrossTeam` is for internal auto-poke use only; MCP tool entry MUST NOT pass it.
  - [x] **Verify REFACTOR:** Re-run the two targeted test files.
    - Command: `npx vitest run tests/poke-cross-team-allow-flag.test.ts tests/poke-validation.test.ts`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/poke-cross-team-allow-flag.test.ts (3 tests) — all pass
      ❯ tests/poke-validation.test.ts (6 tests | 1 failed)
        ✓ cross_team_denied when caller and target are in different teams — PASS (regression-preserving)
        × tmux_pane_not_set — PRE-EXISTING baseline failure (unrelated)
       Test Files  1 failed | 1 passed (2)
            Tests  1 failed | 8 passed (9)
      ```
  - [x] **Commit:** `feat(poke): allowCrossTeam flag on PokeDeps for internal auto-poke`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `8572259`

- [x] 1.2 Wire `createAutoPokeImpl` to pass `allowCrossTeam:true` to `poke()`
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `Cross-team send_message triggers a successful auto-poke`
  - **Files:**
    - Create: `tests/auto-poke-impl-cross-team.test.ts`
    - Modify: `src/mcp/tools.ts` (only the `createAutoPokeImpl` function body, around line 76)
  - [x] **RED:** Write failing test — `tests/auto-poke-impl-cross-team.test.ts`
    - Behavior under test: `createAutoPokeImpl(db, agents)` returns an `AutoPokeFn`; invoking it with `fromAgentId` in team alpha and `targetAgentId` in team beta returns `{ ok: true }` (proving it actually pokes, not `guard_failed`).
    - Expected failure reason: current `tools.ts:76-79` calls `poke({ db, callerAgentId: args.fromAgentId }, ...)` without `allowCrossTeam:true`. Task 1.1's GREEN already landed the flag, so the internal call without the flag returns `cross_team_denied`; `tools.ts:85` maps it to `{ok: false, reason: 'guard_failed'}`.
    ```typescript
    import { describe, it, expect, vi, afterEach } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { openDb } from '../src/storage/db.js'
    import { applySchema } from '../src/storage/schema.js'
    import { AgentsRepo } from '../src/storage/agents-repo.js'

    vi.mock('../src/daemon/tmux-cli.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/daemon/tmux-cli.js')>()
      return {
        ...actual,
        isTmuxAvailable: vi.fn(async () => true),
        capturePaneTail: vi.fn(async () => 'tail'),
        loadBuffer: vi.fn(async () => {}),
        pasteBuffer: vi.fn(async () => {}),
        sendEnter: vi.fn(async () => {})
      }
    })

    import { createAutoPokeImpl } from '../src/mcp/tools.js'

    const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-autopoke-xteam-'))

    describe('createAutoPokeImpl cross-team', () => {
      const dirs: string[] = []
      afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

      function seed(db: ReturnType<typeof openDb>, agent_id: string, team: string, name: string, pane: string | null): void {
        const now = new Date().toISOString()
        db.prepare(
          `INSERT INTO agents (agent_id, team, role, name, model, registered_at, last_seen_at, tmux_pane_id)
           VALUES (?,?,?,?,?,?,?,?)`
        ).run(agent_id, team, 'r', name, null, now, now, pane)
      }

      it('cross-team fan-out poke succeeds (not guard_failed via cross_team_denied)', async () => {
        const dir = tmp(); dirs.push(dir)
        const db = openDb(join(dir, 'data.db'))
        applySchema(db)
        seed(db, 'A', 'alpha', 'alice', '%pA')
        seed(db, 'B', 'beta', 'bob', '%pB')

        const autoPoke = createAutoPokeImpl(db, new AgentsRepo(db))
        const res = await autoPoke({
          team: 'beta',
          fromAgentId: 'A',
          targetAgentId: 'B',
          paneId: '%pB',
          body: 'anything (body stays in mailbox; poke injects hint only)'
        })
        expect(res).toEqual({ ok: true })
      })
    })
    ```
  - [x] **Verify RED:** Run test, confirm it fails because autoPokeImpl currently maps `cross_team_denied` to `{ok:false, reason:'guard_failed'}`.
    - Command: `npx vitest run tests/auto-poke-impl-cross-team.test.ts`
    - **Observed output (fill during apply):**
      ```
       FAIL  tests/auto-poke-impl-cross-team.test.ts > createAutoPokeImpl cross-team > cross-team fan-out poke succeeds (not guard_failed via cross_team_denied)
      AssertionError: expected { ok: false, reason: 'guard_failed' } to deeply equal { ok: true }

      - Expected
      + Received

        Object {
      -   "ok": true,
      +   "ok": false,
      +   "reason": "guard_failed",
        }

       ❯ tests/auto-poke-impl-cross-team.test.ts:52:17
       Test Files  1 failed (1)
            Tests  1 failed (1)
      ```
  - [x] **GREEN:** Modify `src/mcp/tools.ts` `createAutoPokeImpl` function (around line 76) to pass `allowCrossTeam: true` in the `PokeDeps`:
    ```typescript
    const res = await poke(
      { db, callerAgentId: args.fromAgentId, allowCrossTeam: true },
      { target_agent_id: args.targetAgentId, prompt: hint }
    )
    ```
    The surrounding logic (building the hint, mapping errors to skip reasons) is unchanged.
  - [x] **Verify GREEN:** Targeted test + full suite pass.
    - Command: `npx vitest run tests/auto-poke-impl-cross-team.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      # Targeted:
      ✓ tests/auto-poke-impl-cross-team.test.ts (1 test) 809ms
        ✓ createAutoPokeImpl cross-team > cross-team fan-out poke succeeds (not guard_failed via cross_team_denied) 808ms
       Test Files  1 passed (1)
            Tests  1 passed (1)

      # Full suite:
       Test Files  3 failed | 77 passed (80)
            Tests  4 failed | 253 passed (257)
      # 4 failing tests are pre-existing baseline (from tighten-agent-identity — A/B clients colliding on session id in multi-client tests); no new regressions introduced by this change. This task adds +1 test (257 vs 256 after task 1.1).
      ```
  - [x] **REFACTOR:** None — the edit is a single constant argument flip. Confirm by re-running the target.
  - [x] **Verify REFACTOR:** Re-run the targeted test file.
    - Command: `npx vitest run tests/auto-poke-impl-cross-team.test.ts`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/auto-poke-impl-cross-team.test.ts (1 test) 809ms
         ✓ createAutoPokeImpl cross-team > cross-team fan-out poke succeeds (not guard_failed via cross_team_denied) 808ms

       Test Files  1 passed (1)
            Tests  1 passed (1)
      ```
  - [x] **Commit:** `fix(auto-poke): bypass cross-team check when invoking internal poke()`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `29db6ba`

## Scenario Coverage Matrix

| Capability | Scenario | Covered by Task(s) | Test file:line |
|---|---|---|---|
| `agent-interrupts` | `Cross-team target via MCP tool` | Task 1.1 (regression-preserving) | `tests/poke-validation.test.ts:119` + `tests/poke-cross-team-allow-flag.test.ts` (first assertion) |
| `agent-interrupts` | `Cross-team send_message triggers a successful auto-poke` | Task 1.2 | `tests/auto-poke-impl-cross-team.test.ts` |
| `agent-interrupts` | `Direct MCP poke call with the same cross-team pair still denied` | Task 1.1 (regression-preserving) | `tests/poke-validation.test.ts:119` |

**Coverage:** 3 of 3 scenarios covered (100%).
