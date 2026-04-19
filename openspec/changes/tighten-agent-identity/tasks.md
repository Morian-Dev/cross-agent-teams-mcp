# Tasks

## 1. Schema and storage layer

- [x] 1.1 Rewrite `agents_identity_idx` to be UNIQUE on `(team, name)`
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `Fresh database creates UNIQUE identity index on (team, name)`
    - `agent-registry/spec.md` → Scenario: `agents table columns match schema`
    - `agent-registry/spec.md` → Scenario: `Inserting two rows with same (team, name) violates UNIQUE constraint`
  - **Files:**
    - Create: `tests/agents-identity-unique-index.test.ts`
    - Modify: `src/storage/schema.ts`
  - [x] **RED:** Write failing test — `tests/agents-identity-unique-index.test.ts`
    - Behavior under test: fresh-boot DB has UNIQUE index `agents_identity_idx` on exactly `(team, name)`; inserting a second row with same (team, name) but different role raises `UNIQUE constraint failed`.
    - Expected failure reason: current `src/storage/schema.ts:114` defines `CREATE INDEX IF NOT EXISTS agents_identity_idx ON agents(team, name, role)` (non-UNIQUE, three columns). PRAGMA assertions fail on unique flag and column list; INSERT collision test fails because no UNIQUE constraint rejects it.
    ```typescript
    import { describe, it, expect, afterEach } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { openDb } from '../src/storage/db.js'
    import { applySchema } from '../src/storage/schema.js'

    const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-identity-idx-'))

    interface IndexListRow { name: string; unique: number }
    interface IndexInfoRow { seqno: number; cid: number; name: string }

    describe('agents_identity_idx UNIQUE on (team, name)', () => {
      const dirs: string[] = []
      afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

      function freshDb(): ReturnType<typeof openDb> {
        const dir = tmp(); dirs.push(dir)
        const db = openDb(join(dir, 'data.db'))
        applySchema(db)
        return db
      }

      it('index is marked UNIQUE', () => {
        const db = freshDb()
        const idx = db.prepare(`PRAGMA index_list('agents')`).all() as IndexListRow[]
        const row = idx.find(r => r.name === 'agents_identity_idx')
        expect(row).toBeDefined()
        expect(row!.unique).toBe(1)
      })

      it('index covers exactly team and name in order', () => {
        const db = freshDb()
        const info = db.prepare(`PRAGMA index_info('agents_identity_idx')`).all() as IndexInfoRow[]
        const names = info.sort((a, b) => a.seqno - b.seqno).map(r => r.name)
        expect(names).toEqual(['team', 'name'])
      })

      it('inserting two rows with same (team, name) raises UNIQUE constraint failed', () => {
        const db = freshDb()
        const now = new Date().toISOString()
        const insert = db.prepare(
          `INSERT INTO agents (agent_id, team, role, name, model, registered_at, last_seen_at, tmux_pane_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        insert.run('X', 'default', 'backend', 'alice', null, now, now, null)
        expect(() => {
          insert.run('Y', 'default', 'frontend', 'alice', null, now, now, null)
        }).toThrow(/UNIQUE constraint failed/)
      })
    })
    ```
  - [x] **Verify RED:** Run test, confirm it fails because current index is non-UNIQUE on three columns.
    - Command: `npx vitest run tests/agents-identity-unique-index.test.ts`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ❯ tests/agents-identity-unique-index.test.ts (3 tests | 3 failed) 11ms
         × agents_identity_idx UNIQUE on (team, name) > index is marked UNIQUE 7ms
           → expected +0 to be 1 // Object.is equality
         × agents_identity_idx UNIQUE on (team, name) > index covers exactly team and name in order 2ms
           → expected [ 'team', 'name', 'role' ] to deeply equal [ 'team', 'name' ]
         × agents_identity_idx UNIQUE on (team, name) > inserting two rows with same (team, name) raises UNIQUE constraint failed 2ms
           → expected [Function] to throw an error

      ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯

       FAIL  tests/agents-identity-unique-index.test.ts > agents_identity_idx UNIQUE on (team, name) > index is marked UNIQUE
      AssertionError: expected +0 to be 1 // Object.is equality
      - Expected
      + Received
      - 1
      + 0
       ❯ tests/agents-identity-unique-index.test.ts:29:25

       FAIL  tests/agents-identity-unique-index.test.ts > agents_identity_idx UNIQUE on (team, name) > index covers exactly team and name in order
      AssertionError: expected [ 'team', 'name', 'role' ] to deeply equal [ 'team', 'name' ]
        Array [
          "team",
          "name",
      +   "role",
        ]
       ❯ tests/agents-identity-unique-index.test.ts:36:19

       FAIL  tests/agents-identity-unique-index.test.ts > agents_identity_idx UNIQUE on (team, name) > inserting two rows with same (team, name) raises UNIQUE constraint failed
      AssertionError: expected [Function] to throw an error
      - Expected: null
      + Received: undefined
       ❯ tests/agents-identity-unique-index.test.ts:49:8

       Test Files  1 failed (1)
            Tests  3 failed (3)
         Duration  150ms
      ```
  - [x] **GREEN:** Replace `agents_identity_idx` DDL in `src/storage/schema.ts`
    ```typescript
    // In src/storage/schema.ts DDL array — replace this line:
    //   `CREATE INDEX IF NOT EXISTS agents_identity_idx ON agents(team, name, role)`,
    // with:
    `CREATE UNIQUE INDEX IF NOT EXISTS agents_identity_idx ON agents(team, name)`,
    ```
  - [x] **Verify GREEN:** Targeted test passes.
    - Command: `npx vitest run tests/agents-identity-unique-index.test.ts`
    - Full-suite command: `pnpm test` (expect cascading failures in tests that assume three-column non-unique index; fixed in 1.2 / 2.1 / 3.1)
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/agents-identity-unique-index.test.ts (3 tests) 7ms

       Test Files  1 passed (1)
            Tests  3 passed (3)
         Duration  139ms

      Full suite deferred — expected cascading failures in agents-repo / register-agent tests, to be handled by later tasks (1.2 / 2.1).
      ```
  - [x] **REFACTOR:** None — DDL is already minimal.
  - [x] **Verify REFACTOR:** Re-run the targeted test file.
    - Command: `npx vitest run tests/agents-identity-unique-index.test.ts`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/agents-identity-unique-index.test.ts (3 tests) 8ms

       Test Files  1 passed (1)
            Tests  3 passed (3)
         Duration  130ms
      ```
  - [x] **Commit:** `refactor(schema): agents_identity_idx UNIQUE on (team, name)`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `eb0c791163637b64d2edbe51c99d4393d40c6ece`

- [x] 1.2 Rewrite `AgentsRepo.findByIdentity` + `register` to use `(team, name)` identity with ON CONFLICT upsert
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `New identity creates a fresh agent_id`
    - `agent-registry/spec.md` → Scenario: `Reconnect reuses existing agent_id`
    - `agent-registry/spec.md` → Scenario: `Role change updates existing agent_id in-place`
    - `agent-registry/spec.md` → Scenario: `Reuse updates tmux_pane_id when provided`
    - `agent-registry/spec.md` → Scenario: `Reuse preserves tmux_pane_id when omitted`
    - `agent-registry/spec.md` → Scenario: `Team change produces new agent_id`
    - `agent-registry/spec.md` → Scenario: `Re-register after reconnect preserves mailbox continuity`
  - **Files:**
    - Create: `tests/agents-repo-identity-team-name.test.ts`
    - Modify: `src/storage/agents-repo.ts`
  - [x] **RED:** Write failing test — `tests/agents-repo-identity-team-name.test.ts`
    - Behavior under test: `findByIdentity` takes `{team, name}` (no role); `register` called with same (team, name) different role returns the same `agent_id` and updates role, `last_seen_at`; `registered_at` and `last_processed_event_id` preserved.
    - Expected failure reason: current `findByIdentity({team, name, role})` signature (at `src/storage/agents-repo.ts:27`) rejects the two-arg shape (TS compile error); current `register` (at `src/storage/agents-repo.ts:37`) branches on (team, name, role) so role change inserts a new row, failing the "same agent_id" assertion.
    ```typescript
    import { describe, it, expect, afterEach } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { openDb } from '../src/storage/db.js'
    import { applySchema } from '../src/storage/schema.js'
    import { AgentsRepo } from '../src/storage/agents-repo.js'

    const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-agents-identity-tn-'))

    describe('AgentsRepo identity is (team, name)', () => {
      const dirs: string[] = []
      afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

      function fresh(): { db: ReturnType<typeof openDb>; repo: AgentsRepo } {
        const dir = tmp(); dirs.push(dir)
        const db = openDb(join(dir, 'data.db'))
        applySchema(db)
        return { db, repo: new AgentsRepo(db) }
      }

      it('findByIdentity takes {team, name} only and returns the row when it exists', () => {
        const { db, repo } = fresh()
        const r = repo.register({ name: 'alice', role: 'backend', team: 'default', model: 'opus' })
        expect('agent_id' in r).toBe(true)
        const id = (r as { agent_id: string }).agent_id
        const found = repo.findByIdentity({ team: 'default', name: 'alice' })
        expect(found?.agent_id).toBe(id)
        void db
      })

      it('register returns same agent_id when (team, name) matches, regardless of role', () => {
        const { repo } = fresh()
        const r1 = repo.register({ name: 'alice', role: 'backend', team: 'default', model: 'opus' })
        const id1 = (r1 as { agent_id: string }).agent_id
        const r2 = repo.register({ name: 'alice', role: 'frontend', team: 'default', model: 'sonnet' })
        const id2 = (r2 as { agent_id: string }).agent_id
        expect(id2).toBe(id1)
      })

      it('role change updates existing row in place (single row, new role, same agent_id)', () => {
        const { db, repo } = fresh()
        repo.register({ name: 'alice', role: 'backend', team: 'default', model: 'opus' })
        repo.register({ name: 'alice', role: 'frontend', team: 'default', model: 'opus' })
        const rows = db.prepare(`SELECT agent_id, role FROM agents WHERE team='default' AND name='alice'`).all() as Array<{ agent_id: string; role: string }>
        expect(rows).toHaveLength(1)
        expect(rows[0].role).toBe('frontend')
      })

      it('role change preserves registered_at and last_processed_event_id', () => {
        const { db, repo } = fresh()
        const r1 = repo.register({ name: 'alice', role: 'backend', team: 'default', model: 'opus' })
        const id1 = (r1 as { agent_id: string }).agent_id
        const row1 = db.prepare(`SELECT registered_at FROM agents WHERE agent_id=?`).get(id1) as { registered_at: string }
        db.prepare(`UPDATE agents SET last_processed_event_id=? WHERE agent_id=?`).run(5, id1)
        repo.register({ name: 'alice', role: 'frontend', team: 'default', model: 'opus' })
        const row2 = db.prepare(`SELECT registered_at, last_processed_event_id FROM agents WHERE agent_id=?`).get(id1) as { registered_at: string; last_processed_event_id: number }
        expect(row2.registered_at).toBe(row1.registered_at)
        expect(row2.last_processed_event_id).toBe(5)
      })

      it('tmux_pane_id update on reuse when provided', () => {
        const { db, repo } = fresh()
        const r = repo.register({ name: 'alice', role: 'backend', team: 'default', model: 'opus', tmux_pane_id: '%42' })
        const id = (r as { agent_id: string }).agent_id
        repo.register({ name: 'alice', role: 'backend', team: 'default', model: 'opus', tmux_pane_id: '%99' })
        const row = db.prepare(`SELECT tmux_pane_id FROM agents WHERE agent_id=?`).get(id) as { tmux_pane_id: string }
        expect(row.tmux_pane_id).toBe('%99')
      })

      it('tmux_pane_id preserved on reuse when omitted', () => {
        const { db, repo } = fresh()
        const r = repo.register({ name: 'alice', role: 'backend', team: 'default', model: 'opus', tmux_pane_id: '%42' })
        const id = (r as { agent_id: string }).agent_id
        repo.register({ name: 'alice', role: 'backend', team: 'default', model: 'opus' })
        const row = db.prepare(`SELECT tmux_pane_id FROM agents WHERE agent_id=?`).get(id) as { tmux_pane_id: string }
        expect(row.tmux_pane_id).toBe('%42')
      })

      it('team change produces a new agent_id', () => {
        const { repo } = fresh()
        const r1 = repo.register({ name: 'alice', role: 'backend', team: 'default', model: 'opus' })
        const id1 = (r1 as { agent_id: string }).agent_id
        const r2 = repo.register({ name: 'alice', role: 'backend', team: 'alpha', model: 'opus' })
        const id2 = (r2 as { agent_id: string }).agent_id
        expect(id2).not.toBe(id1)
      })
    })
    ```
  - [x] **Verify RED:** Run the test, confirm compile/assertion failures.
    - Command: `npx vitest run tests/agents-repo-identity-team-name.test.ts`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ❯ tests/agents-repo-identity-team-name.test.ts (7 tests | 4 failed) 14ms
         × findByIdentity takes {team, name} only and returns the row when it exists 6ms
           → expected undefined to be '65b72ff2-3c54-46b3-8b48-adea3b15de70'
         × register returns same agent_id when (team, name) matches, regardless of role 2ms
           → UNIQUE constraint failed: agents.team, agents.name
         × role change updates existing row in place (single row, new role, same agent_id) 1ms
           → UNIQUE constraint failed: agents.team, agents.name
         × role change preserves registered_at and last_processed_event_id 1ms
           → UNIQUE constraint failed: agents.team, agents.name

       Test Files  1 failed (1)
            Tests  4 failed | 3 passed (7)
      ```
  - [x] **GREEN:** Rewrite `src/storage/agents-repo.ts`
    ```typescript
    // src/storage/agents-repo.ts
    import type Database from 'better-sqlite3'
    import { randomUUID } from 'node:crypto'

    export const ONLINE_MS = 5 * 60 * 1000

    export interface AgentsRow {
      agent_id: string
      team: string
      role: string
      name: string
      model: string | null
      tmux_pane_id: string | null
      registered_at: string
      last_seen_at: string
      last_processed_event_id: number
    }

    export interface RegisterInput {
      name: string
      role?: string
      team?: string
      model: string
      tmux_pane_id?: string
    }

    export type RegisterResult = { agent_id: string; team: string }

    export class AgentsRepo {
      constructor(private db: Database.Database) {}

      findById(agent_id: string): AgentsRow | undefined {
        return this.db.prepare(
          `SELECT agent_id, team, role, name, model, tmux_pane_id, registered_at, last_seen_at, last_processed_event_id FROM agents WHERE agent_id=?`
        ).get(agent_id) as AgentsRow | undefined
      }

      findByIdentity(args: { team: string; name: string }): { agent_id: string } | undefined {
        return this.db.prepare(
          `SELECT agent_id FROM agents WHERE team=? AND name=?`
        ).get(args.team, args.name) as { agent_id: string } | undefined
      }

      register(input: RegisterInput): RegisterResult {
        const team = input.team ?? 'default'
        const role = input.role ?? 'default'
        const name = input.name
        const now = new Date().toISOString()
        const newId = randomUUID()
        // ON CONFLICT (team, name) → keep original agent_id + registered_at + last_processed_event_id;
        // overwrite role / model / last_seen_at; preserve tmux_pane_id when incoming is NULL.
        this.db.prepare(
          `INSERT INTO agents (agent_id, team, role, name, model, registered_at, last_seen_at, tmux_pane_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (team, name) DO UPDATE SET
             role = excluded.role,
             model = excluded.model,
             last_seen_at = excluded.last_seen_at,
             tmux_pane_id = COALESCE(excluded.tmux_pane_id, tmux_pane_id)`
        ).run(newId, team, role, name, input.model, now, now, input.tmux_pane_id ?? null)
        const row = this.db.prepare(`SELECT agent_id FROM agents WHERE team=? AND name=?`).get(team, name) as { agent_id: string }
        return { agent_id: row.agent_id, team }
      }

      touch(agent_id: string): void {
        this.db.prepare(`UPDATE agents SET last_seen_at=? WHERE agent_id=?`).run(new Date().toISOString(), agent_id)
      }

      listByTeam(args: { team: string }): Array<{ agent_id: string; role: string; name: string; model: string | null; tmux_pane_id: string | null; last_seen_at: string }> {
        return this.db.prepare(
          `SELECT agent_id, role, name, model, tmux_pane_id, last_seen_at FROM agents WHERE team=? ORDER BY registered_at ASC`
        ).all(args.team) as Array<{ agent_id: string; role: string; name: string; model: string | null; tmux_pane_id: string | null; last_seen_at: string }>
      }
    }
    ```
    Preserve any existing methods not shown above (e.g., helper getters) — read the current file and merge.
  - [x] **Verify GREEN:** Targeted test file passes; full suite has expected cascading failures in tests that still call `findByIdentity({team, name, role})` — those get fixed in this task's REFACTOR step.
    - Command: `npx vitest run tests/agents-repo-identity-team-name.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/agents-repo-identity-team-name.test.ts (7 tests) 12ms

       Test Files  1 passed (1)
            Tests  7 passed (7)
         Duration  141ms
      ```
  - [x] **REFACTOR:** Migrate call sites and legacy tests:
    - Grep for `findByIdentity(` across `src/` and `tests/`. Every call must pass `{team, name}` only. Drop `role` from call sites.
    - In `tests/agents-repo.test.ts`: any scenario asserting "role change produces new agent_id" is inverted by this change — update to assert "role change returns same agent_id, role column updated". Drop or migrate any test that can't be reconciled.
    - In `tests/agents-schema.test.ts`: update PRAGMA assertions to expect UNIQUE index on `(team, name)` — may already be handled by task 1.1's test; dedupe if needed.
    - Run full suite; non-register-agent suites should be green again.
  - [x] **Verify REFACTOR:** Full suite.
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       Test Files  4 failed | 73 passed (77)
            Tests  5 failed | 245 passed (250)
         Duration  9.48s

      Remaining failing suites (all OUT OF SCOPE for task 1.2):
      - tests/poke-e2e.test.ts (2 tests) — pre-existing self_poke_denied regressions, unrelated to identity
      - tests/poke-tmux-unavailable.test.ts (1 test) — pre-existing self_poke_denied
      - tests/poke-validation.test.ts (1 test) — pre-existing self_poke_denied
      - tests/register-agent-idempotency.test.ts scenario 5 — intentionally migrated to expect
        {error:'agent_id_collision'} for cross-session cross-role; will turn green in task 2.1.

      Baseline pre-1.2: 7 test files failing / 12 tests failing. Post-1.2: 4 / 5. All identity-
      related repo failures resolved. Remaining 1 register-service failure is task 2.1's scope;
      4 poke failures are pre-existing and unrelated.
      ```
  - [x] **Commit:** `refactor(agents-repo): identity by (team, name) via ON CONFLICT upsert`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `a147dfa088a58b8fc4c93d9751ddfcc19626d95e`

## 2. MCP layer

- [ ] 2.1 Narrow `RegisterAgentService.identityKey` to `(team, name)` and assert cross-role collision
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `Same (team, name) claimed by a different role from another live session is a collision`
    - `agent-registry/spec.md` → Scenario: `Different Authorization credentials on same session id`
    - `agent-registry/spec.md` → Scenario: `Cross-session same identity under different Authorization reuses agent_id`
    - `agent-registry/spec.md` → Scenario: `Same session re-registers with new tmux_pane_id`
  - **Files:**
    - Create: `tests/register-service-identity-collision.test.ts`
    - Modify: `src/mcp/register-agent.ts`
  - [ ] **RED:** Write failing test — `tests/register-service-identity-collision.test.ts`
    - Behavior under test: session X registers `(default, alice, backend)`; session Y attempts `(default, alice, frontend)` → expects `{error:'agent_id_collision'}`. After Y is released via `releaseConnection`, session Z can register `(default, alice, frontend)` and receives the same agent_id as the original registration.
    - Expected failure reason: current `identityKey(team, name, role)` at `src/mcp/register-agent.ts:17` uses all three; session Y with different role gets a different key, so the existing binding check at line 32 doesn't trigger — Y proceeds to upsert via AgentsRepo and ends up either succeeding or colliding at DB layer (after 1.1 lands UNIQUE). Neither path returns `agent_id_collision` at the service level as the spec requires.
    ```typescript
    import { describe, it, expect, afterEach } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { openDb } from '../src/storage/db.js'
    import { applySchema } from '../src/storage/schema.js'
    import { RegisterAgentService } from '../src/mcp/register-agent.js'

    const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-reg-service-identity-'))

    describe('RegisterAgentService identity is (team, name)', () => {
      const dirs: string[] = []
      afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

      function fresh(): RegisterAgentService {
        const dir = tmp(); dirs.push(dir)
        const db = openDb(join(dir, 'data.db'))
        applySchema(db)
        return new RegisterAgentService(db)
      }

      it('second session with same (team, name) different role gets agent_id_collision', () => {
        const svc = fresh()
        const r1 = svc.register({ connection_id: 'sess-A', model: 'opus', name: 'alice', role: 'backend', team: 'default' })
        expect('agent_id' in r1).toBe(true)
        const r2 = svc.register({ connection_id: 'sess-B', model: 'opus', name: 'alice', role: 'frontend', team: 'default' })
        expect(r2).toEqual({ error: 'agent_id_collision' })
      })

      it('same session re-registering same (team, name) with new role is a reuse, not collision', () => {
        const svc = fresh()
        const r1 = svc.register({ connection_id: 'sess-A', model: 'opus', name: 'alice', role: 'backend', team: 'default' })
        const id1 = (r1 as { agent_id: string }).agent_id
        const r2 = svc.register({ connection_id: 'sess-A', model: 'opus', name: 'alice', role: 'frontend', team: 'default' })
        expect('agent_id' in r2).toBe(true)
        expect((r2 as { agent_id: string }).agent_id).toBe(id1)
      })

      it('after releaseConnection, a different session can take over (team, name)', () => {
        const svc = fresh()
        const r1 = svc.register({ connection_id: 'sess-A', model: 'opus', name: 'alice', role: 'backend', team: 'default' })
        const id1 = (r1 as { agent_id: string }).agent_id
        svc.releaseConnection(id1, 'sess-A')
        const r2 = svc.register({ connection_id: 'sess-B', model: 'opus', name: 'alice', role: 'frontend', team: 'default' })
        expect('agent_id' in r2).toBe(true)
        expect((r2 as { agent_id: string }).agent_id).toBe(id1)
      })
    })
    ```
  - [ ] **Verify RED:** Run the test, confirm at least the "cross-session different role → collision" case fails.
    - Command: `npx vitest run tests/register-service-identity-collision.test.ts`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **GREEN:** Rewrite identityKey in `src/mcp/register-agent.ts`
    ```typescript
    // src/mcp/register-agent.ts — replace identityKey function:
    function identityKey(team: string, name: string): string {
      return `${team}\u0000${name}`
    }

    // And update its call site in RegisterAgentService.register:
    //   const key = identityKey(team, input.name, role)
    // becomes:
    //   const key = identityKey(team, input.name)
    //
    // The rest of the method (connections Map check, delegation to this.repo.register) is unchanged.
    ```
  - [ ] **Verify GREEN:** Targeted test + full suite.
    - Command: `npx vitest run tests/register-service-identity-collision.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **REFACTOR:** Review `tests/agent-id-collision.test.ts` and `tests/agent-id-collision-auth-hash.test.ts` for any lingering assertion that assumed three-tuple keying. Update or delete as needed. Grep for `identityKey(` in `src/` and confirm every call passes only `(team, name)`.
  - [ ] **Verify REFACTOR:** Full suite.
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      <to be filled by ts-apply>
      ```
  - [ ] **Commit:** `refactor(register-agent): narrow identityKey to (team, name) and collide cross-role`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `<to be filled by ts-apply>`

## 3. Documentation sync

- [ ] 3.1 Sync auto-memory `project_p2_agent_id_reuse.md` to reflect (team, name) two-tuple identity
  - kind: skip-doc-only
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `Role change updates existing agent_id in-place`
  - [ ] **SKIP:** skip-doc-only — auto-memory file at `/Users/jtianling/.claude/projects/-Users-jtianling-workspace-agent-teams-mcp-workspace-agent-teams-mcp-tdd-spec/memory/project_p2_agent_id_reuse.md` is a discussion-level note about identity reuse; it must be rewritten to say: "identity = (team, name); role is informational, not part of identity; tmux_pane_id is an updateable attribute, never part of identity; previous four-tuple wording (team, tmux_pane_id, display_name, role) was inaccurate even before this change and is now fully superseded." No runtime behavior depends on this file; no test can verify it.

## Scenario Coverage Matrix

| Capability | Scenario | Covered by Task(s) | Test file:line |
|---|---|---|---|
| `agent-registry` | `Fresh database creates UNIQUE identity index on (team, name)` | Task 1.1 | `tests/agents-identity-unique-index.test.ts` |
| `agent-registry` | `agents table columns match schema` | Task 1.1 | `tests/agents-identity-unique-index.test.ts` (or pre-existing `tests/agents-schema.test.ts`) |
| `agent-registry` | `Inserting two rows with same (team, name) violates UNIQUE constraint` | Task 1.1 | `tests/agents-identity-unique-index.test.ts` |
| `agent-registry` | `New identity creates a fresh agent_id` | Task 1.2 | `tests/agents-repo-identity-team-name.test.ts` |
| `agent-registry` | `Reconnect reuses existing agent_id` | Task 1.2 | `tests/agents-repo-identity-team-name.test.ts` |
| `agent-registry` | `Role change updates existing agent_id in-place` | Task 1.2 | `tests/agents-repo-identity-team-name.test.ts` |
| `agent-registry` | `Reuse updates tmux_pane_id when provided` | Task 1.2 | `tests/agents-repo-identity-team-name.test.ts` |
| `agent-registry` | `Reuse preserves tmux_pane_id when omitted` | Task 1.2 | `tests/agents-repo-identity-team-name.test.ts` |
| `agent-registry` | `Team change produces new agent_id` | Task 1.2 | `tests/agents-repo-identity-team-name.test.ts` |
| `agent-registry` | `Name is required and must be non-empty` | Task 1.2 (regression-preserving; covered by existing Zod schema tests) | `tests/register-agent-name.test.ts` (pre-existing) |
| `agent-registry` | `Name after trim must be non-empty` | Task 1.2 (regression-preserving) | `tests/register-agent-name.test.ts` (pre-existing) |
| `agent-registry` | `Role defaults to "default" when omitted` | Task 1.2 (regression-preserving) | `tests/register-agent-name.test.ts` (pre-existing) |
| `agent-registry` | `Team defaults to "default" when omitted` | Task 1.2 (regression-preserving) | `tests/register-agent-name.test.ts` (pre-existing) |
| `agent-registry` | `Same session re-registers with new tmux_pane_id` | Task 2.1 | `tests/register-service-identity-collision.test.ts` + pre-existing |
| `agent-registry` | `Re-register after reconnect preserves mailbox continuity` | Task 1.2 | `tests/agents-repo-identity-team-name.test.ts` |
| `agent-registry` | `Different Authorization credentials on same session id` | Task 2.1 (regression-preserving; pre-existing tests) | `tests/agent-id-collision-auth-hash.test.ts` |
| `agent-registry` | `Cross-session same identity under different Authorization reuses agent_id` | Task 2.1 (regression-preserving) | `tests/agent-id-collision-auth-hash.test.ts` |
| `agent-registry` | `Same (team, name) claimed by a different role from another live session is a collision` | Task 2.1 | `tests/register-service-identity-collision.test.ts` |

**Coverage:** 18 of 18 scenarios covered (100%).
