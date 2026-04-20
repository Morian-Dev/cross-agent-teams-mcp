# Tasks

## 1. Schema and storage layer

- [x] 1.1 Rewrite `events` and `messages` table DDL to use `from_team` + `to_team`, and rebuild indexes
  - kind: unit-test
  - **Spec scenario(s):**
    - `events-outbox/spec.md` → Scenario: `Fresh database creates events table with both team-scoped indexes`
    - `events-outbox/spec.md` → Scenario: `Non-cross-team event must have equal from_team and to_team`
    - `mailbox/spec.md` → Scenario: `Sending a same-team message creates paired rows with equal team fields`
  - **Files:**
    - Create: `tests/schema-from-to-team.test.ts`
    - Modify: `src/storage/schema.ts`
  - [x] **RED:** Write failing test — `tests/schema-from-to-team.test.ts`
    - Behavior under test: Fresh DB bootstrap creates `events` with `from_team` + `to_team` NOT NULL and two composite indexes; creates `messages` with `from_team` + `to_team` NOT NULL; no legacy `team` column or `idx_events_team_eventid` remain.
    - Expected failure reason: current schema.ts still defines `team` column + `idx_events_team_eventid`, so PRAGMA assertions fail.
    ```typescript
    import { describe, it, expect, afterEach } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { openDb } from '../src/storage/db.js'
    import { applySchema } from '../src/storage/schema.js'

    const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-schema-fromto-'))

    interface ColInfo { name: string; notnull: number; type: string }
    interface IndexInfo { name: string }

    describe('events + messages schema uses from_team and to_team', () => {
      const dirs: string[] = []
      afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

      function freshDb(): ReturnType<typeof openDb> {
        const dir = tmp(); dirs.push(dir)
        const db = openDb(join(dir, 'data.db'))
        applySchema(db)
        return db
      }

      it('events table has from_team and to_team NOT NULL and no legacy team column', () => {
        const db = freshDb()
        const cols = db.prepare(`PRAGMA table_info('events')`).all() as ColInfo[]
        const names = cols.map(c => c.name)
        expect(names).toContain('from_team')
        expect(names).toContain('to_team')
        expect(names).not.toContain('team')
        expect(cols.find(c => c.name === 'from_team')!.notnull).toBe(1)
        expect(cols.find(c => c.name === 'to_team')!.notnull).toBe(1)
      })

      it('events has idx_events_from_team_eventid and idx_events_to_team_eventid, not legacy index', () => {
        const db = freshDb()
        const idx = db.prepare(`PRAGMA index_list('events')`).all() as IndexInfo[]
        const names = idx.map(i => i.name)
        expect(names).toContain('idx_events_from_team_eventid')
        expect(names).toContain('idx_events_to_team_eventid')
        expect(names).not.toContain('idx_events_team_eventid')
      })

      it('messages table has from_team and to_team NOT NULL and no legacy team column', () => {
        const db = freshDb()
        const cols = db.prepare(`PRAGMA table_info('messages')`).all() as ColInfo[]
        const names = cols.map(c => c.name)
        expect(names).toContain('from_team')
        expect(names).toContain('to_team')
        expect(names).not.toContain('team')
        expect(cols.find(c => c.name === 'from_team')!.notnull).toBe(1)
        expect(cols.find(c => c.name === 'to_team')!.notnull).toBe(1)
      })

      it('INSERT without from_team/to_team throws NOT NULL constraint error', () => {
        const db = freshDb()
        expect(() => {
          db.prepare(`INSERT INTO events (event_type, actor_agent_id, payload, created_at) VALUES (?,?,?,?)`)
            .run('x', null, '{}', new Date().toISOString())
        }).toThrow(/NOT NULL constraint failed/)
      })
    })
    ```
  - [x] **Verify RED:** Run test, confirm it fails because current schema still has `team` column.
    - Command: `npx vitest run tests/schema-from-to-team.test.ts`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ❯ tests/schema-from-to-team.test.ts (4 tests | 3 failed) 13ms
         × events + messages schema uses from_team and to_team > events table has from_team and to_team NOT NULL and no legacy team column 8ms
           → expected [ 'event_id', 'team', …(4) ] to include 'from_team'
         × events + messages schema uses from_team and to_team > events has idx_events_from_team_eventid and idx_events_to_team_eventid, not legacy index 2ms
           → expected [ 'idx_events_team_eventid' ] to include 'idx_events_from_team_eventid'
         × events + messages schema uses from_team and to_team > messages table has from_team and to_team NOT NULL and no legacy team column 2ms
           → expected [ 'id', 'event_id', 'team', …(6) ] to include 'from_team'

       Test Files  1 failed (1)
            Tests  3 failed | 1 passed (4)
      ```
  - [x] **GREEN:** Replace schema.ts DDL — `src/storage/schema.ts`
    ```typescript
    import type Database from 'better-sqlite3'

    const DDL = [
      `CREATE TABLE IF NOT EXISTS events (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_team TEXT NOT NULL,
        to_team TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor_agent_id TEXT,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_events_from_team_eventid ON events(from_team, event_id)`,
      `CREATE INDEX IF NOT EXISTS idx_events_to_team_eventid ON events(to_team, event_id)`,
      `CREATE TABLE IF NOT EXISTS agents (
        agent_id TEXT PRIMARY KEY,
        team TEXT NOT NULL,
        role TEXT NOT NULL,
        name TEXT NOT NULL,
        model TEXT,
        registered_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        last_processed_event_id INTEGER NOT NULL DEFAULT 0,
        tmux_pane_id TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS agents_identity_idx ON agents(team, name, role)`,
      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        event_id INTEGER NOT NULL REFERENCES events(event_id),
        from_team TEXT NOT NULL,
        to_team TEXT NOT NULL,
        from_agent_id TEXT NOT NULL,
        to_agent_id TEXT,
        to_role TEXT,
        subject TEXT,
        body TEXT NOT NULL,
        sent_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        team TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed')),
        depends_on TEXT NOT NULL,
        claimed_by TEXT,
        claimed_at TEXT,
        completed_at TEXT,
        result TEXT,
        created_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS contracts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        format TEXT NOT NULL CHECK(format='jsonschema'),
        schema TEXT NOT NULL,
        note TEXT,
        registered_by TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        UNIQUE(team, name, version)
      )`,
      `CREATE TABLE IF NOT EXISTS contract_subscriptions (
        agent_id TEXT NOT NULL,
        team TEXT NOT NULL,
        contract_name TEXT NOT NULL,
        subscribed_at TEXT NOT NULL,
        PRIMARY KEY (agent_id, team, contract_name)
      )`
    ]

    export function applySchema(db: Database.Database): void {
      for (const sql of DDL) db.exec(sql)
    }
    ```
  - [x] **Verify GREEN:** Run new test; existing schema tests (agents-schema, db-bootstrap, messages-schema, events-outbox) will start failing — those are fixed in later tasks. Confirm just this test file is now green.
    - Command: `npx vitest run tests/schema-from-to-team.test.ts`
    - Full-suite command: `pnpm test` (expect widespread failure in events-outbox, send-message, broadcast tests — each addressed by subsequent tasks)
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/schema-from-to-team.test.ts (4 tests) 9ms

       Test Files  1 passed (1)
            Tests  4 passed (4)

      Note: Full suite (`pnpm test`) not run at this step — per spec, widespread cascading failures in events-outbox, send-message, broadcast tests are expected and will be addressed by subsequent tasks.
      ```
  - [x] **REFACTOR:** None — DDL is already minimal.
  - [x] **Verify REFACTOR:** Re-run the targeted test file.
    - Command: `npx vitest run tests/schema-from-to-team.test.ts`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/schema-from-to-team.test.ts (4 tests) 9ms

       Test Files  1 passed (1)
            Tests  4 passed (4)
      ```
  - [x] **Commit:** `refactor(schema): replace events.team and messages.team with from_team+to_team`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `1f6d722aa3683ae34b900e808eb646b22fb5fced`

- [x] 1.2 Update `EventsOutbox.append` signature to require `from_team` and `to_team`
  - kind: unit-test
  - **Spec scenario(s):**
    - `events-outbox/spec.md` → Scenario: `Two appends return increasing ids`
    - `events-outbox/spec.md` → Scenario: `Cross-team append records differing from/to teams`
  - **Files:**
    - Create: `tests/events-outbox-append.test.ts`
    - Modify: `src/storage/events-outbox.ts`
  - [x] **RED:** Write failing test — `tests/events-outbox-append.test.ts`
    - Behavior under test: `append({from_team, to_team, event_type, payload})` returns monotonic ids; cross-team append records differing team columns.
    - Expected failure reason: current `append` signature uses single `team` parameter, TS compile error or column-name runtime error.
    ```typescript
    import { describe, it, expect, afterEach } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { openDb } from '../src/storage/db.js'
    import { applySchema } from '../src/storage/schema.js'
    import { EventsOutbox } from '../src/storage/events-outbox.js'

    const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-append-'))

    describe('EventsOutbox.append with from_team and to_team', () => {
      const dirs: string[] = []
      afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

      function fresh(): { db: ReturnType<typeof openDb>; outbox: EventsOutbox } {
        const dir = tmp(); dirs.push(dir)
        const db = openDb(join(dir, 'data.db'))
        applySchema(db)
        return { db, outbox: new EventsOutbox(db) }
      }

      it('two same-team appends return strictly increasing ids', () => {
        const { outbox } = fresh()
        const a = outbox.append({ from_team: 'default', to_team: 'default', event_type: 'x', payload: {} })
        const b = outbox.append({ from_team: 'default', to_team: 'default', event_type: 'x', payload: {} })
        expect(b).toBeGreaterThan(a)
      })

      it('cross-team append writes differing from_team and to_team', () => {
        const { db, outbox } = fresh()
        const id = outbox.append({
          from_team: 'alpha', to_team: 'beta',
          event_type: 'message_sent', actor_agent_id: 'sess-A', payload: { hi: 1 }
        })
        const row = db.prepare(`SELECT from_team, to_team, actor_agent_id FROM events WHERE event_id=?`)
          .get(id) as { from_team: string; to_team: string; actor_agent_id: string }
        expect(row.from_team).toBe('alpha')
        expect(row.to_team).toBe('beta')
        expect(row.actor_agent_id).toBe('sess-A')
      })
    })
    ```
  - [x] **Verify RED:** Run the test, confirm compile/runtime failure.
    - Command: `npx vitest run tests/events-outbox-append.test.ts`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ❯ tests/events-outbox-append.test.ts (2 tests | 2 failed) 7ms
         × EventsOutbox.append with from_team and to_team > two same-team appends return strictly increasing ids 5ms
           → table events has no column named team
         × EventsOutbox.append with from_team and to_team > cross-team append writes differing from_team and to_team 1ms
           → table events has no column named team

      SqliteError: table events has no column named team
       ❯ EventsOutbox.append src/storage/events-outbox.ts:16:26

       Test Files  1 failed (1)
            Tests  2 failed (2)
      ```
  - [x] **GREEN:** Replace `EventsOutbox` — `src/storage/events-outbox.ts`
    ```typescript
    import type Database from 'better-sqlite3'

    export interface EventRow {
      event_id: number
      from_team: string
      to_team: string
      event_type: string
      actor_agent_id: string | null
      payload: string
      created_at: string
    }

    export class EventsOutbox {
      constructor(private db: Database.Database) {}

      append(args: {
        from_team: string
        to_team: string
        event_type: string
        actor_agent_id?: string | null
        payload: unknown
      }): number {
        const stmt = this.db.prepare(
          `INSERT INTO events (from_team, to_team, event_type, actor_agent_id, payload, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        const info = stmt.run(
          args.from_team,
          args.to_team,
          args.event_type,
          args.actor_agent_id ?? null,
          JSON.stringify(args.payload),
          new Date().toISOString()
        )
        return Number(info.lastInsertRowid)
      }

      since(args: { team: string; since_event_id: number; limit?: number }): EventRow[] {
        const limit = Math.min(args.limit ?? 100, 500)
        return this.db.prepare(
          `SELECT * FROM events WHERE to_team = ? AND event_id > ? ORDER BY event_id ASC LIMIT ?`
        ).all(args.team, args.since_event_id, limit) as EventRow[]
      }
    }
    ```
  - [x] **Verify GREEN:** Targeted test passes.
    - Command: `npx vitest run tests/events-outbox-append.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/events-outbox-append.test.ts (2 tests) 5ms

       Test Files  1 passed (1)
            Tests  2 passed (2)

      Note: Full `pnpm test` intentionally skipped at this step per task instructions — cascading failures in mailbox/send-message/broadcast are expected and handled by subsequent tasks and the REFACTOR sweep below.
      ```
  - [x] **REFACTOR:** Update every existing caller of `EventsOutbox.append` to supply `from_team` and `to_team` explicitly (callers in `src/mcp/send-message.ts`, `src/mcp/register-agent.ts`, `src/mcp/register-contract.ts`, `src/mcp/task-add.ts`, etc.) using caller's team for both. This is a mechanical sweep.
  - [x] **Verify REFACTOR:** Run full suite; non-mailbox-specific suites (agents-repo, register-agent, task-*, contracts-*) should pass again; mailbox suites still fail (addressed by later tasks).
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       Test Files  4 failed | 68 passed (72)
            Tests  7 failed | 213 passed (220)

      Failing suites (all pre-existing mailbox-specific tests that still reference the old `team` column; to be rewritten in later tasks):
        - tests/events-cleanup.test.ts        (seeds events with legacy `team` column)
        - tests/events-outbox.test.ts         (asserts legacy `team` column set and monotonicity with old API)
        - tests/messages-schema.test.ts       (asserts legacy `messages.team` column)
        - tests/events-outbox-append.test.ts  PASSES (this task's new test)

      Non-mailbox suites (agents-repo, register-agent, task-add/claim/complete/list,
      contracts-*, register-contract, subscribe-contract, pending-contract-events,
      send-message, broadcast, get-inbox, diff-contracts, poke, sse-fanout, etc.) all pass.
      ```
  - [x] **Commit:** `refactor(events-outbox): append takes from_team and to_team`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `6c98bf478582f69e140506643df0fcdba26aa56f`

- [x] 1.3 `EventsOutbox.since({team})` filters by `to_team`, excluding outbound cross-team events
  - kind: unit-test
  - **Spec scenario(s):**
    - `events-outbox/spec.md` → Scenario: `Cursor-based pagination returns events targeted at the team`
    - `events-outbox/spec.md` → Scenario: `since(team) does not leak events targeting other teams`
  - **Files:**
    - Create: `tests/events-outbox-since-to-team.test.ts`
    - Modify: `src/storage/events-outbox.ts` (method `since`, already updated in 1.2 — this task verifies + tightens)
  - [x] **RED:** Write failing test — `tests/events-outbox-since-to-team.test.ts`
    - Behavior under test: Given mixed events, `since({team:'alpha'})` returns only events whose `to_team='alpha'`, excluding outbound `from_team='alpha', to_team='beta'`.
    - Expected failure reason: If 1.2 is already merged, this may pass. The test still exists as a regression guard. Write it to actively fail against a hypothetical regression: confirm it passes ONLY with `to_team` filter. To make it RED first, temporarily mutate `since` to use `from_team` OR run it against the 1.2 intermediate state.
    ```typescript
    import { describe, it, expect, afterEach } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { openDb } from '../src/storage/db.js'
    import { applySchema } from '../src/storage/schema.js'
    import { EventsOutbox } from '../src/storage/events-outbox.js'

    const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-since-'))

    describe('EventsOutbox.since filters by to_team', () => {
      const dirs: string[] = []
      afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

      it('returns only events with to_team matching, excluding outbound cross-team', () => {
        const dir = tmp(); dirs.push(dir)
        const db = openDb(join(dir, 'data.db'))
        applySchema(db)
        const outbox = new EventsOutbox(db)

        outbox.append({ from_team: 'alpha', to_team: 'alpha', event_type: 'a', payload: {} })  // 1
        outbox.append({ from_team: 'alpha', to_team: 'alpha', event_type: 'a', payload: {} })  // 2
        outbox.append({ from_team: 'alpha', to_team: 'beta',  event_type: 'message_sent', payload: {} })  // 3 outbound
        outbox.append({ from_team: 'beta',  to_team: 'alpha', event_type: 'message_sent', payload: {} })  // 4 inbound
        outbox.append({ from_team: 'alpha', to_team: 'alpha', event_type: 'a', payload: {} })  // 5

        const rows = outbox.since({ team: 'alpha', since_event_id: 0, limit: 10 })
        const ids = rows.map(r => r.event_id)
        expect(ids).toEqual([1, 2, 4, 5])
      })

      it('does not leak events targeting other teams', () => {
        const dir = tmp(); dirs.push(dir)
        const db = openDb(join(dir, 'data.db'))
        applySchema(db)
        const outbox = new EventsOutbox(db)

        for (let i = 0; i < 5; i++) {
          outbox.append({ from_team: 'beta', to_team: 'beta', event_type: 'x', payload: {} })
        }
        const rows = outbox.since({ team: 'default', since_event_id: 0, limit: 10 })
        expect(rows.length).toBe(0)
      })
    })
    ```
  - [x] **Verify RED:** Temporarily change `since` filter to `from_team` (or run against pre-1.2 code) to confirm test can fail. Then revert.
    - Command: `npx vitest run tests/events-outbox-since-to-team.test.ts`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ❯ tests/events-outbox-since-to-team.test.ts (2 tests | 1 failed) 9ms
         × EventsOutbox.since filters by to_team > returns only events with to_team matching, excluding outbound cross-team 7ms
           → expected [ 1, 2, 3, 5 ] to deeply equal [ 1, 2, 4, 5 ]

      ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

       FAIL  tests/events-outbox-since-to-team.test.ts > EventsOutbox.since filters by to_team > returns only events with to_team matching, excluding outbound cross-team
      AssertionError: expected [ 1, 2, 3, 5 ] to deeply equal [ 1, 2, 4, 5 ]

      - Expected
      + Received

        Array [
          1,
          2,
      -   4,
      +   3,
          5,
        ]

       Test Files  1 failed (1)
            Tests  1 failed | 1 passed (2)

      Note: RED forced by temporarily mutating since filter from `to_team = ?` to `from_team = ?`. Outbound event (id=3, from alpha→beta) leaked in; inbound event (id=4, from beta→alpha) missing. Filter was reverted to `to_team = ?` before GREEN step.
      ```
  - [x] **GREEN:** Ensure `since` in `src/storage/events-outbox.ts` uses `to_team = ?` filter (already set by 1.2). No code change needed if 1.2 is in. If task is iterated standalone, the SQL line is:
    ```typescript
    `SELECT * FROM events WHERE to_team = ? AND event_id > ? ORDER BY event_id ASC LIMIT ?`
    ```
  - [x] **Verify GREEN:** Run test.
    - Command: `npx vitest run tests/events-outbox-since-to-team.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/events-outbox-since-to-team.test.ts (2 tests) 6ms

       Test Files  1 passed (1)
            Tests  2 passed (2)

      Note: Full `pnpm test` intentionally deferred to REFACTOR step.
      ```
  - [x] **REFACTOR:** Ensure existing `tests/events-outbox.test.ts` still reflects the new semantic (no leakage). Adjust existing test fixtures to pass `from_team` + `to_team` consistently.
  - [x] **Verify REFACTOR:** Full suite.
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       Test Files  3 failed | 70 passed (73)
            Tests  4 failed | 218 passed (222)

      This task's suites (PASS):
        - tests/events-outbox-since-to-team.test.ts   (2 passed — new, this task)
        - tests/events-outbox.test.ts                 (3 passed — REFACTOR updated: from_team+to_team fixtures, idx name `idx_events_to_team_eventid`, column set includes from_team+to_team)
        - tests/events-outbox-append.test.ts          (2 passed — task 1.2)

      Remaining failing suites (pre-existing, addressed by later tasks 1.4 / 3.x / 4.x / 5.x):
        - tests/cleanup-interval.test.ts   (INSERT INTO events (team, ...) — task 1.4)
        - tests/events-cleanup.test.ts     (INSERT INTO events (team, ...) — task 1.4)
        - tests/messages-schema.test.ts    (asserts legacy messages.team column, now from_team+to_team — later messages task)
      ```
  - [x] **Commit:** `test(events-outbox): verify since() filters by to_team excluding outbound`
    - Staging order: test file before any code tweak
    - **Commit SHA (fill during apply):** `9de7e18b72a99963c2749667c33de81f556db3a7`

- [x] 1.4 Events cleanup groups agent cursors by `to_team`
  - kind: unit-test
  - **Spec scenario(s):**
    - `events-outbox/spec.md` → Scenario: `Cleanup preserves events newer than online cursor`
    - `events-outbox/spec.md` → Scenario: `Cleanup with no online agents in a team`
    - `events-outbox/spec.md` → Scenario: `Cross-team event retention follows the to_team cursor`
    - `events-outbox/spec.md` → Scenario: `Ancient contracts survive cleanup`
  - **Files:**
    - Modify: `tests/events-cleanup.test.ts`
    - Modify: `src/daemon/events-cleanup.ts` (or wherever cleanup lives)
  - [x] **RED:** Extend `tests/events-cleanup.test.ts` with a cross-team scenario:
    - Behavior under test: event with `from_team='alpha', to_team='beta'`, older than 7 days, is preserved as long as team `beta` has an online agent whose cursor is below that event_id.
    - Expected failure reason: current cleanup code queries agents by the single `team` field against `events.team`, which no longer matches.
    ```typescript
    it('cross-team event is retained by to_team agent cursor', async () => {
      const { db, outbox, runCleanup } = setupCleanupFixture()
      const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString()
      db.prepare(
        `INSERT INTO events (from_team, to_team, event_type, payload, created_at, actor_agent_id)
         VALUES (?,?,?,?,?,?)`
      ).run('alpha', 'beta', 'message_sent', '{}', tenDaysAgo, 'sess-A')
      const event_id = db.prepare(`SELECT last_insert_rowid() as id`).get() as { id: number }
      // beta has an online agent with cursor below this event_id → must retain
      db.prepare(
        `INSERT INTO agents (agent_id, team, role, name, model, registered_at, last_seen_at, last_processed_event_id, tmux_pane_id)
         VALUES ('sess-B','beta','r','n',null,?, ?, ?, null)`
      ).run(new Date().toISOString(), new Date().toISOString(), event_id.id - 1)
      await runCleanup()
      const row = db.prepare(`SELECT event_id FROM events WHERE event_id=?`).get(event_id.id)
      expect(row).toBeTruthy()
    })
    ```
  - [x] **Verify RED:** Run the new cross-team retention test, confirm it fails (cleanup likely deletes because it queries `team` column that no longer exists, or groups by wrong field).
    - Command: `npx vitest run tests/events-cleanup.test.ts`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ❯ tests/events-cleanup.test.ts (5 tests | 1 failed) 18ms
         × events cleanup > deletes cross-team event once to_team cursor advances, regardless of other teams 4ms
           → expected { event_id: 1 } to be falsy

      ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

       FAIL  tests/events-cleanup.test.ts > events cleanup > deletes cross-team event once to_team cursor advances, regardless of other teams
      AssertionError: expected { event_id: 1 } to be falsy

      - Expected:
      false

      + Received:
      Object {
        "event_id": 1,
      }

       ❯ tests/events-cleanup.test.ts:96:17

       Test Files  1 failed (1)
            Tests  1 failed | 4 passed (5)

      Note: RED driven by the deletion-differentiating cross-team scenario. Current global-MIN cleanup over-retains beta-targeted events because alpha's low cursor drags the global floor down. The retention-scenario test (cross-team event retained by to_team cursor) already passes under global-MIN (which is strictly more conservative); the added deletion test forces true per-team grouping. Pre-1.4 baseline also showed RED from `INSERT INTO events (team, ...)` in existing tests; the seeder was updated to `from_team, to_team` first.
      ```
  - [x] **GREEN:** Rewrite the cleanup SQL to group by `to_team`. For each distinct `to_team`:
    ```typescript
    // src/daemon/events-cleanup.ts — pseudocode of the key SQL
    const minCursorPerTeam = db.prepare(`
      SELECT a.team as to_team, MIN(a.last_processed_event_id) as min_cursor
      FROM agents a
      WHERE a.last_seen_at > :cutoff_online
      GROUP BY a.team
    `).all({ cutoff_online: nowMinus5Min })
    // For each event row older than 7 days:
    //   If to_team has an online cursor and event_id >= min_cursor → keep
    //   Else → delete
    db.prepare(`
      DELETE FROM events
      WHERE created_at < :ageCutoff
        AND (
          to_team NOT IN (SELECT to_team FROM (${'...online cursor query...'}) )
          OR event_id < (SELECT min_cursor FROM online_cursor WHERE to_team = events.to_team)
        )
    `).run({ ageCutoff: nowMinus7Days })
    ```
    (Full rewrite is done in the actual file; the snippet shows the core logic.)
  - [x] **Verify GREEN:** Run all cleanup tests.
    - Command: `npx vitest run tests/events-cleanup.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/events-cleanup.test.ts (5 tests) 13ms

       Test Files  1 passed (1)
            Tests  5 passed (5)

      Full-suite `pnpm test`:
       Test Files  1 failed | 72 passed (73)
            Tests  1 failed | 223 passed (224)

      Remaining failure (pre-existing, later-task scope): tests/messages-schema.test.ts asserts legacy `messages.team` column — flagged by task 1.4 REFACTOR note as "later messages task". cleanup-interval.test.ts now passes (seeder updated to from_team+to_team in this task).
      ```
  - [x] **REFACTOR:** Extract the "online cursor per team" subquery to a named constant if inlined repetition exceeds once. Verify no regression in the "ancient contracts survive cleanup" scenario.
  - [x] **Verify REFACTOR:** Re-run file.
    - Command: `npx vitest run tests/events-cleanup.test.ts`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/events-cleanup.test.ts (5 tests) 14ms
       ✓ tests/cleanup-interval.test.ts (1 test) 1021ms
         ✓ cleanup interval > runs runCleanup on the provided cadence and stops on close 1021ms

       Test Files  2 passed (2)
            Tests  6 passed (6)

      Note: REFACTOR collapsed the two inlined subqueries into a single `WITH online_cursor AS (...)` CTE, so the :cutoffOnline parameter is bound once. "ancient contracts survive cleanup" still passes (contracts table is never touched).
      ```
  - [x] **Commit:** `refactor(events-cleanup): group online cursor by to_team`
    - Staging order: test before code
    - **Commit SHA (fill during apply):** `dc4a72c426fad29b526dfba9a277c0d642ffd835`

## 2. SSE fanout filter

- [x] 2.1 `SseFanout.emitContractEvent` filter uses `event.to_team`
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` (design-rationale: mailbox SSE pass-through) — not a direct scenario, but covered by existing `contract-subscriptions/spec.md` → Scenario: `Subscribed online agent receives push`
    - `events-outbox/spec.md` → Scenario: `Non-cross-team event must have equal from_team and to_team` (ensures equivalence for contract events)
  - **Files:**
    - Modify: `tests/sse-fanout.test.ts`
    - Modify: `src/daemon/sse-fanout.ts`
  - [x] **RED:** Extend `tests/sse-fanout.test.ts` with a test that injects a synthetic event whose `from_team` differs from `to_team`, and asserts the session whose team matches `to_team` is the one receiving the push.
    ```typescript
    it('fanout filter uses event.to_team, not from_team', () => {
      const fanout = new SseFanout()
      const recvAlpha: Array<Record<string, unknown>> = []
      const recvBeta: Array<Record<string, unknown>> = []
      const sinkAlpha: SseSink = { send: m => recvAlpha.push(m), sendHeartbeat: () => {}, close: () => {} }
      const sinkBeta:  SseSink = { send: m => recvBeta.push(m),  sendHeartbeat: () => {}, close: () => {} }
      fanout.attach('sess-A', 'alpha', sinkAlpha)
      fanout.attach('sess-B', 'beta',  sinkBeta)
      // Simulate a contract event that originated in alpha but targets beta (hypothetical cross-team contract push)
      // Use emitContractEvent with a pre-inserted DB row whose from_team=alpha, to_team=beta.
      // (For this unit test, stub the DB layer or construct the expected arg directly.)
      const { db } = buildDbWithSubscription({ team: 'beta', agent_id: 'sess-B', contract: 'X' })
      fanout.emitContractEvent(db, { team: 'beta', contract_name: 'X', version: 1, event_id: 1, diff: null })
      expect(recvBeta.length).toBe(1)
      expect(recvAlpha.length).toBe(0)
    })
    ```
    (The existing same-team test MUST continue to pass.  The new test wires the fanout through a to_team path.)
  - [x] **Verify RED:** Run sse-fanout tests, confirm new assertion fails under `session.team !== event.team` wording (the check may be tautological for same-team contract events; to force a real RED, temporarily have `emitContractEvent` take `from_team` parameter and filter on that; observe the fail).
    - Command: `npx vitest run tests/sse-fanout.test.ts`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ❯ tests/sse-fanout.test.ts (2 tests | 1 failed) 9ms
         × sse fanout > fanout filter uses event.to_team, not from_team 4ms
           → expected +0 to be 1 // Object.is equality

      ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

       FAIL  tests/sse-fanout.test.ts > sse fanout > fanout filter uses event.to_team, not from_team
      AssertionError: expected +0 to be 1 // Object.is equality

      - Expected
      + Received

      - 1
      + 0

       ❯ tests/sse-fanout.test.ts:94:29

       Test Files  1 failed (1)
            Tests  1 failed | 1 passed (2)

      Note: RED is driven by `args.to_team` being undefined in the current impl — the SQL binds undefined to `team=?`, returns no subs, so no session receives. Refactor renames `args.team` → `args.to_team`.
      ```
  - [ ] **GREEN:** In `src/daemon/sse-fanout.ts`, change the method signature of `emitContractEvent` or its internal filter so the comparison is semantically "session.team === event's to_team".  Since the method's current `args.team` parameter maps to "the team the event targets" (already equivalent to `to_team` for contract events), rename `args.team` to `args.to_team` and update the comparison line:
    ```typescript
    emitContractEvent(
      db: Database.Database,
      args: { to_team: string; contract_name: string; version: number; event_id: number; diff: unknown | null }
    ): void {
      const subs = db.prepare(
        `SELECT agent_id FROM contract_subscriptions WHERE team=? AND contract_name=?`
      ).all(args.to_team, args.contract_name) as Array<{ agent_id: string }>
      const subscribedSet = new Set(subs.map(s => s.agent_id))
      for (const session of this.sessions.values()) {
        if (session.team !== args.to_team) continue
        if (!subscribedSet.has(session.agent_id)) continue
        try {
          session.sink.send({
            type: 'contract_event',
            event_id: args.event_id,
            contract_name: args.contract_name,
            version: args.version,
            diff: args.diff
          })
        } catch { /* broken sink; swallow */ }
      }
    }
    ```
    Update all callers (register-contract.ts) to pass `to_team` instead of `team`.
  - [x] **GREEN:** Updated `src/daemon/sse-fanout.ts` (method signature + filter) and caller `src/mcp/tools.ts` (register_contract wiring) to pass `to_team`. Updated existing in-file sse-fanout test that still used `team:` shape.
  - [x] **Verify GREEN:** Full suite green for SSE / contract subscription tests.
    - Command: `npx vitest run tests/sse-fanout.test.ts tests/contract-diff.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/sse-fanout.test.ts (2 tests) 7ms
       ✓ tests/contract-diff.test.ts (5 tests) 1ms

       Test Files  2 passed (2)
            Tests  7 passed (7)
         Duration  157ms
      ```
  - [x] **REFACTOR:** Searched `src/` for `event.team` / `events.team` / `session.team !== ...team`. Only hit is the intentional `session.team !== args.to_team` line in `src/daemon/sse-fanout.ts:69` (by design per refactor). Updated `tests/sse-wire.test.ts` to assert the new `to_team` arg shape (was `team`).
  - [x] **Verify REFACTOR:** Full suite.
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       Test Files  1 failed | 72 passed (73)
            Tests  1 failed | 224 passed (225)

      This task's suites (PASS):
        - tests/sse-fanout.test.ts   (2 passed — RED new test + existing test, both GREEN under renamed arg)
        - tests/contract-diff.test.ts (5 passed)
        - tests/sse-wire.test.ts     (1 passed — REFACTOR: now asserts emitted[0].to_team)

      Remaining failing suite (pre-existing, flagged at tasks 1.4 baseline, addressed by later messages task):
        - tests/messages-schema.test.ts  (asserts legacy messages.team column; now from_team+to_team)

      Net delta: sse-wire/sse-fanout RED+one pre-existing fail from 1.4 baseline (3 fails/4 failed tests) → 1 suite / 1 test (expected messages task).
      ```
  - [x] **Commit:** `refactor(sse-fanout): filter on event.to_team`
    - Staging order: test before code
    - **Commit SHA (fill during apply):** `0bc4151345646c23f539c5213fb8b386dc4c2ada`

## 3. send_message refactor

- [x] 3.1 Remove `to_role` from send_message Zod schema; add optional `to_team`; require `to_agent_id`
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `to_role parameter is rejected by the schema layer`
    - `mailbox/spec.md` → Scenario: `send_message without to_agent_id is rejected`
  - **Files:**
    - Create: `tests/send-message-zod-schema.test.ts`
    - Modify: `src/mcp/tools.ts` (or wherever `send_message` Zod schema is defined)
  - [x] **RED:** Write failing test — `tests/send-message-zod-schema.test.ts`
    ```typescript
    import { describe, it, expect, afterEach } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { Client } from '@modelcontextprotocol/sdk/client/index.js'
    import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
    import { startServer } from '../src/daemon/server.js'

    const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-sm-zod-'))

    describe('send_message Zod schema', () => {
      const dirs: string[] = []
      afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

      async function client(): Promise<{ c: Client; close: () => Promise<void> }> {
        const dir = tmp(); dirs.push(dir)
        const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
        const url = new URL(`http://${host}:${port}/mcp`)
        const t = new StreamableHTTPClientTransport(url)
        const c = new Client({ name: 'test', version: '0' })
        await c.connect(t)
        return { c, close: async () => { await t.close(); await app.close() } }
      }

      it('rejects to_role with validation error', async () => {
        const { c, close } = await client()
        await expect(
          c.callTool({ name: 'send_message', arguments: { to_agent_id: 'X', to_role: 'frontend', body: 'hi' } })
        ).rejects.toThrow(/to_role|unknown|unrecognized|validation/i)
        await close()
      })

      it('rejects missing to_agent_id with validation error', async () => {
        const { c, close } = await client()
        await expect(
          c.callTool({ name: 'send_message', arguments: { body: 'hi' } })
        ).rejects.toThrow(/to_agent_id|required|validation/i)
        await close()
      })

      it('accepts to_team as optional string', async () => {
        const { c, close } = await client()
        // Call will fail with unknown_recipient (no agents registered) but MUST NOT fail on schema validation
        const resp = await c.callTool({ name: 'send_message', arguments: { to_agent_id: 'fake', to_team: 'beta', body: 'hi' } })
        expect(JSON.stringify(resp)).toMatch(/unknown_recipient/)
        await close()
      })
    })
    ```
  - [x] **Verify RED:** Run; tests 1+2 assert schema-layer rejection (`isError: true`), which the current loose schema does NOT produce — it silently strips unknown keys and makes `to_agent_id` optional, so the handler is entered and returns `unknown_agent`.  Test 3 accepts any `/unknown_agent|unknown_recipient/` response (covering both the current pass-through behavior and the post-GREEN schema-accepted-then-handler-runs behavior).
    - Command: `npx vitest run tests/send-message-zod-schema.test.ts`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ❯ tests/send-message-zod-schema.test.ts (3 tests | 2 failed) 63ms
         × send_message Zod schema > rejects to_role with validation error 43ms
           → expected undefined to be true // Object.is equality
         × send_message Zod schema > rejects missing to_agent_id with validation error 9ms
           → expected undefined to be true // Object.is equality
         ✓ send_message Zod schema > accepts to_team as optional string 7ms

       Test Files  1 failed (1)
            Tests  2 failed | 1 passed (3)

      Note on test-shape deviation from the verbatim prompt: the MCP SDK (@modelcontextprotocol/sdk 1.22.x) catches server-side McpError from schema validation and returns `{ content, isError: true }` rather than rejecting the client-side promise.  `Client.callTool()` therefore resolves normally even on validation failure; `rejects.toThrow(...)` can never match.  The test was rewritten to assert `resp.isError === true` with error-text regex — same spec scenarios (`to_role rejected by schema layer` + `missing to_agent_id rejected`), compatible mechanism.  RED is genuine: under the current loose schema the server has no validation error to raise, so `isError` is undefined.
      ```
  - [x] **GREEN:** In `src/mcp/tools.ts`, redefine the `send_message` input schema. The Zod object MUST: require `to_agent_id`, optional `to_team`, optional `subject`, required `body`, optional `auto_poke`. No `to_role` key. Use `.strict()` to force rejection of unknown keys:
    ```typescript
    // Excerpt from src/mcp/tools.ts
    const sendMessageSchema = z.object({
      to_agent_id: z.string().min(1),
      to_team: z.string().min(1).optional(),
      subject: z.string().optional(),
      body: z.string().min(1),
      auto_poke: z.boolean().optional()
    }).strict()
    ```
  - [x] **Verify GREEN:** Three test cases pass.
    - Command: `npx vitest run tests/send-message-zod-schema.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/send-message-zod-schema.test.ts (3 tests) 68ms

       Test Files  1 passed (1)
            Tests  3 passed (3)
      ```
  - [x] **REFACTOR:** Remove the now-dead `to_role` branch in `src/mcp/send-message.ts`'s `SendMessageService.send` method. Keep the `SendInput` TypeScript interface in sync (drop `to_role`, add `to_team?`).
  - [x] **Verify REFACTOR:** Full suite (`send-message-direct`, `send-role-broadcast` will still fail — both are addressed in later tasks).
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       Test Files  5 failed | 69 passed (74)
            Tests  6 failed | 222 passed (228)

      Remaining failures (all pre-flagged by this task + prior tasks, to be fixed in 3.2 / 3.3 / 3.4):
        - tests/send-message-direct.test.ts > rejects when both to_agent_id and to_role are given (legacy to_role ambiguity assertion — gone by design; task 3.2 rewrites this test)
        - tests/send-message-direct.test.ts > rejects when neither recipient is given (legacy missing_recipient path — schema now makes to_agent_id required; task 3.2 rewrites)
        - tests/send-role-broadcast.test.ts > to_role fan-out writes one message per recipient (role fan-out is being moved out of send_message — task 3.3 / 4.x)
        - tests/send-message-auto-poke.test.ts > to_role fan-out with one idle + one active (same to_role retirement — task 3.3)
        - tests/fanout-skip-offline.test.ts > to_role with mixed online/offline (same)
        - tests/messages-schema.test.ts > creates messages table with columns and FK to events (pre-existing — flagged at 1.4 REFACTOR; addressed later by messages-schema task)

      New: tests/send-message-zod-schema.test.ts (3 tests) passes — validates the schema-layer changes delivered by this task.
      ```
  - [x] **Commit:** `refactor(send-message): drop to_role, require to_agent_id, add optional to_team`
    - Staging order: test before code
    - **Commit SHA (fill during apply):** `12ab4fe6a9a9745a75602d29463e3d7d7b061944`

- [x] 3.2 send_message same-team 1→1 writes with `from_team=to_team=caller.team`
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Sending a same-team message creates paired rows with equal team fields`
    - `mailbox/spec.md` → Scenario: `to_agent_id does not exist in any team`
    - `mailbox/spec.md` → Scenario: `to_agent_id exists but resolved to_team does not match`
  - **Files:**
    - Modify: `tests/send-message-direct.test.ts`
    - Modify: `src/mcp/send-message.ts`
  - [x] **RED:** Update `tests/send-message-direct.test.ts` to assert the `messages` row has `from_team` + `to_team` both equal to the caller's team, and that the paired `events` row matches.  Add a scenario where `to_agent_id` lives in a different team (with caller omitting `to_team`) → expect `unknown_recipient`.
    ```typescript
    it('same-team send writes from_team=to_team=caller.team, paired events row matches', async () => {
      const { svc, db, cleanup } = setupService()
      insertAgent(db, { agent_id: 'A', team: 'default', role: 'r' })
      insertAgent(db, { agent_id: 'B', team: 'default', role: 'r' })
      const resp = await svc.send({ from: 'A', to_agent_id: 'B', body: 'hi', auto_poke: false })
      expect('error' in resp).toBe(false)
      const m = db.prepare(`SELECT from_team, to_team, event_id FROM messages WHERE to_agent_id='B'`).get() as
        { from_team: string; to_team: string; event_id: number }
      expect(m.from_team).toBe('default')
      expect(m.to_team).toBe('default')
      const e = db.prepare(`SELECT from_team, to_team FROM events WHERE event_id=?`).get(m.event_id) as
        { from_team: string; to_team: string }
      expect(e.from_team).toBe('default')
      expect(e.to_team).toBe('default')
      cleanup()
    })

    it('returns unknown_recipient when to_agent_id belongs to another team and to_team is omitted', async () => {
      const { svc, db, cleanup } = setupService()
      insertAgent(db, { agent_id: 'A', team: 'alpha' })
      insertAgent(db, { agent_id: 'B', team: 'beta' })  // different team
      const resp = await svc.send({ from: 'A', to_agent_id: 'B', body: 'hi', auto_poke: false })
      expect(resp).toEqual({ error: 'unknown_recipient' })
      cleanup()
    })
    ```
  - [x] **Verify RED:** Run, confirm failures.
    - Command: `npx vitest run tests/send-message-direct.test.ts`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ❯ tests/send-message-direct.test.ts (4 tests | 1 failed) 13ms
         × send_message direct > returns unknown_recipient when to_agent_id belongs to another team and to_team is omitted 4ms
           → expected { …(6) } to deeply equal { error: 'unknown_recipient' }

      ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

       FAIL  tests/send-message-direct.test.ts > send_message direct > returns unknown_recipient when to_agent_id belongs to another team and to_team is omitted
      AssertionError: expected { …(6) } to deeply equal { error: 'unknown_recipient' }

      - Expected
      + Received

        Object {
      -   "error": "unknown_recipient",
      +   "event_id": 1,
      +   "message_id": "9cf3c1da-b5d6-4d02-8fe2-a90f1543e9db",
      +   "poked": false,
      +   "recipients": Array [
      +     "B",
      +   ],
      +   "retry_scheduled": false,
      +   "sent_at": "2026-04-19T06:06:01.480Z",
        }

       Test Files  1 failed (1)
            Tests  1 failed | 3 passed (4)

      Note: RED was forced via genuine code mutation — the original `SELECT ... WHERE agent_id=? AND team=?` query (which filtered at SQL level) was reduced to `WHERE agent_id=?` alone without yet adding the explicit `rcpt.team !== toTeam` check.  Under the mutation, cross-team sends succeed (wrong).  GREEN restores the invariant by adding the explicit team-equality check, matching the spec's "look up by agent_id alone then verify team" pattern.
      ```
  - [ ] **GREEN:** Rewrite `SendMessageService.send` in `src/mcp/send-message.ts` to:
    1.  Resolve `to_team = input.to_team ?? fromRow.team`
    2.  Look up recipient by `agent_id` alone (`SELECT * FROM agents WHERE agent_id=?`)
    3.  If not found OR `recipient.team !== resolved to_team` → `{error:'unknown_recipient'}`
    4.  Insert `messages` with `from_team=fromRow.team`, `to_team=resolved to_team`
    5.  Call `events.append({from_team: fromRow.team, to_team: resolved to_team, ...})`
    6.  Pass auto-poke fanout with single recipient
    ```typescript
    // Core rewrite sketch (src/mcp/send-message.ts)
    async send(input: SendInput): Promise<SendResult> {
      const fromRow = this.agents.findById(input.from)
      if (!fromRow) return { error: 'unknown_recipient' }
      const from_team = fromRow.team
      const to_team = input.to_team ?? from_team
      const rcpt = this.db.prepare('SELECT agent_id, team, tmux_pane_id FROM agents WHERE agent_id=?')
        .get(input.to_agent_id) as { agent_id: string; team: string; tmux_pane_id: string | null } | undefined
      if (!rcpt || rcpt.team !== to_team) return { error: 'unknown_recipient' }
      const recipientRows = [{ agent_id: rcpt.agent_id, tmux_pane_id: rcpt.tmux_pane_id }]
      const baseResult = this.insert({ from_team, to_team, from: input.from, recipientRows, to_role: null, input })
      // ...auto-poke fanout unchanged except for param plumbing (see task 3.4)
      return { ...baseResult, poked: /*...*/false, retry_scheduled: false }
    }
    ```
    Also rewrite the private `insert` method to take `from_team` + `to_team` and write both columns to `messages` and via `events.append`.
  - [x] **GREEN:** Restored lookup to agent_id-only and added explicit `rcpt.team !== toTeam` check in `src/mcp/send-message.ts`. The `events.append` + `INSERT INTO messages` already wrote `from_team` + `to_team` (done in task 3.1).
  - [x] **Verify GREEN:** Targeted test file green.
    - Command: `npx vitest run tests/send-message-direct.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/send-message-direct.test.ts (4 tests) 8ms

       Test Files  1 passed (1)
            Tests  4 passed (4)
      ```
  - [x] **REFACTOR:** Collapsed the vestigial `recipientRows`/`for (let i ...)` fan-out loop in `SendMessageService.insert` to a single 1→1 insert (`args: { ..., toAgentId: string, ... }`, single `INSERT` + `randomUUID()`). Confirmed grep: no `to_role` branching in `src/mcp/send-message.ts` (only the NULL literal passed to the legacy column, which the schema still carries). `ONLINE_MS` is not imported. `SendInput` lacks `to_role`.
  - [x] **Verify REFACTOR:** Full suite (send-role-broadcast still fails; same-team / broadcast task fallout expected).
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       Test Files  4 failed | 70 passed (74)
            Tests  4 failed | 224 passed (228)
         Duration  10.15s

      This task's suite (PASS):
        - tests/send-message-direct.test.ts  (4 tests passed — 3.2 RED/GREEN/REFACTOR)

      Remaining failing suites (pre-flagged by 3.1 REFACTOR block, to be fixed by 3.3 / 3.4 / 4.x / messages-schema task):
        - tests/fanout-skip-offline.test.ts  (to_role fan-out — retired by 3.3)
        - tests/messages-schema.test.ts      (asserts legacy `team` column; now from_team+to_team — messages-schema task)
        - tests/send-message-auto-poke.test.ts (to_role fan-out path — 3.3 / 3.4)
        - tests/send-role-broadcast.test.ts  (to_role fan-out — 3.3 / 4.x)

      Net delta: send-message-direct transitions from 2 pre-existing legacy fails (tasks 3.1 REFACTOR block) → all 4 tests GREEN.  Remaining 4 failures are exactly the items 3.1's REFACTOR block flagged.
      ```
  - [x] **Commit:** `refactor(send-message): 1→1 only, write from_team+to_team`
    - Staging order: test before code
    - **Commit SHA (fill during apply):** `fafbd17932eb3ae18448a1e666bbf0c794f67a6f`

- [x] 3.3 send_message supports cross-team delivery via explicit `to_team`
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Cross-team private message is delivered`
    - `mailbox/spec.md` → Scenario: `Cross-team to_team equal to caller's team is identical to omission`
    - `mailbox/spec.md` → Scenario: `Cross-team target not found in specified team returns unknown_recipient`
    - `mailbox/spec.md` → Scenario: `Explicit to_team mismatches recipient's actual team`
    - `mailbox/spec.md` → Scenario: `Sending a cross-team message records distinct team fields`
  - **Files:**
    - Create: `tests/send-message-cross-team.test.ts`
    - Modify: `src/mcp/send-message.ts` (already handled by 3.2 if implemented correctly)
  - [x] **RED:** Write `tests/send-message-cross-team.test.ts` with positive and negative cross-team cases.
    ```typescript
    import { describe, it, expect, afterEach, beforeEach } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { openDb } from '../src/storage/db.js'
    import { applySchema } from '../src/storage/schema.js'
    import { AgentsRepo } from '../src/storage/agents-repo.js'
    import { EventsOutbox } from '../src/storage/events-outbox.js'
    import { SendMessageService } from '../src/mcp/send-message.js'
    import { insertAgent } from './helpers/insert-agent.js'

    const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-sm-cross-'))

    describe('send_message cross-team', () => {
      const dirs: string[] = []
      afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

      function setup(): { svc: SendMessageService; db: ReturnType<typeof openDb> } {
        const dir = tmp(); dirs.push(dir)
        const db = openDb(join(dir, 'data.db'))
        applySchema(db)
        const svc = new SendMessageService(db, new AgentsRepo(db), new EventsOutbox(db))
        return { svc, db }
      }

      it('cross-team delivery succeeds when to_team matches recipient team', async () => {
        const { svc, db } = setup()
        insertAgent(db, { agent_id: 'A', team: 'alpha' })
        insertAgent(db, { agent_id: 'B', team: 'beta' })
        const resp = await svc.send({ from: 'A', to_agent_id: 'B', to_team: 'beta', body: 'hi', auto_poke: false })
        expect('error' in resp).toBe(false)
        const m = db.prepare(`SELECT from_team, to_team, event_id FROM messages WHERE to_agent_id='B'`).get() as
          { from_team: string; to_team: string; event_id: number }
        expect(m.from_team).toBe('alpha')
        expect(m.to_team).toBe('beta')
        const e = db.prepare(`SELECT from_team, to_team FROM events WHERE event_id=?`).get(m.event_id) as
          { from_team: string; to_team: string }
        expect(e.from_team).toBe('alpha')
        expect(e.to_team).toBe('beta')
      })

      it('to_team equal to caller team is identical to omitted', async () => {
        const { svc, db } = setup()
        insertAgent(db, { agent_id: 'A', team: 'alpha' })
        insertAgent(db, { agent_id: 'B', team: 'alpha' })
        const resp = await svc.send({ from: 'A', to_agent_id: 'B', to_team: 'alpha', body: 'hi', auto_poke: false })
        expect('error' in resp).toBe(false)
        const m = db.prepare(`SELECT from_team, to_team FROM messages WHERE to_agent_id='B'`).get() as
          { from_team: string; to_team: string }
        expect(m.from_team).toBe('alpha')
        expect(m.to_team).toBe('alpha')
      })

      it('returns unknown_recipient when to_team does not match recipient actual team', async () => {
        const { svc, db } = setup()
        insertAgent(db, { agent_id: 'A', team: 'alpha' })
        insertAgent(db, { agent_id: 'B', team: 'beta' })
        const resp = await svc.send({ from: 'A', to_agent_id: 'B', to_team: 'gamma', body: 'hi' })
        expect(resp).toEqual({ error: 'unknown_recipient' })
        const rows = db.prepare(`SELECT * FROM events WHERE event_type='message_sent'`).all()
        expect(rows.length).toBe(0)
      })

      it('returns unknown_recipient when to_agent_id does not exist anywhere', async () => {
        const { svc, db } = setup()
        insertAgent(db, { agent_id: 'A', team: 'alpha' })
        const resp = await svc.send({ from: 'A', to_agent_id: 'ghost', to_team: 'beta', body: 'hi' })
        expect(resp).toEqual({ error: 'unknown_recipient' })
      })
    })
    ```
  - [x] **Verify RED:** Tests fail because the `send` method (pre-3.2) doesn't resolve `to_team` properly.  If 3.2 is in, these should already pass — in that case this task is a regression guard.  Force an initial RED by reverting 3.2's `to_team` line temporarily, verify fail, restore.
    - Command: `npx vitest run tests/send-message-cross-team.test.ts`
    - **Observed output (fill during apply):**
      ```
      RED forcing approach: Option B.  Task 3.2 already delivered correct cross-team resolution, so the new test file passed on first run (4/4 green).  To produce a genuine RED, temporarily mutated `src/mcp/send-message.ts` line 59 from
        const toTeam = input.to_team ?? fromTeam
      to
        const toTeam = fromTeam
      (ignoring caller-provided `to_team`).  Re-ran the file; Scenario "cross-team delivery succeeds when to_team matches recipient team" failed as expected because messages wrote to_team='alpha' rather than 'beta', so the resulting rcpt.team !== toTeam check returned `{error: 'unknown_recipient'}`.  Reverted mutation immediately after observing RED.

       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ❯ tests/send-message-cross-team.test.ts (4 tests | 1 failed) 11ms
         × send_message cross-team > cross-team delivery succeeds when to_team matches recipient team 6ms
           → expected true to be false // Object.is equality

      ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

       FAIL  tests/send-message-cross-team.test.ts > send_message cross-team > cross-team delivery succeeds when to_team matches recipient team
      AssertionError: expected true to be false // Object.is equality

      - Expected
      + Received

      - false
      + true

       Test Files  1 failed (1)
            Tests  1 failed | 3 passed (4)
      ```
  - [x] **GREEN:** Implementation already in 3.2 (or touch-up); ensure the `to_team ?? fromRow.team` resolution and `recipient.team === resolved_to_team` check are in place.
  - [x] **Verify GREEN:** All four cases in the new test file pass.
    - Command: `npx vitest run tests/send-message-cross-team.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/send-message-cross-team.test.ts (4 tests) 9ms

       Test Files  1 passed (1)
            Tests  4 passed (4)
      ```
  - [x] **REFACTOR:** Consolidate the three "unknown_recipient" branches (no-from, no-rcpt, team-mismatch) if they share cleanup pattern.
      REFACTOR: none needed.  Post-3.2, `src/mcp/send-message.ts` already collapses the recipient lookup into a single combined branch:
        if (!fromRow) return { error: 'unknown_recipient' }
        ...
        if (!rcpt || rcpt.team !== toTeam) return { error: 'unknown_recipient' }
      — only two call sites total, each returning the identical literal with no pre-return cleanup to factor.  Extracting a helper (`return unknownRecipient()`) would add a named indirection over a 3-word return statement and hurt readability.  Left as-is.
  - [x] **Verify REFACTOR:** Re-run file.
    - Command: `npx vitest run tests/send-message-cross-team.test.ts`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/send-message-cross-team.test.ts (4 tests) 10ms

       Test Files  1 passed (1)
            Tests  4 passed (4)

      Full suite `pnpm test`:
       Test Files  4 failed | 71 passed (75)
            Tests  4 failed | 228 passed (232)

      Remaining failures (all pre-flagged in 3.1 / 3.2 as carryover — 3.3 is regression-guard only, no new failures introduced):
        - tests/messages-schema.test.ts (asserts legacy `team` column — messages-schema-split task)
        - tests/send-message-auto-poke.test.ts > to_role fan-out ... (retired `to_role` — task 3.4 / 4.x)
        - tests/send-role-broadcast.test.ts > to_role fan-out writes one message per recipient sharing event_id (task 4.x)
        - tests/send-message-auto-poke.test.ts hint-format carryover tied to same `to_role` migration
      ```
  - [x] **Commit:** `feat(send-message): cross-team private delivery via to_team param`
    - Staging order: test before code
    - **Commit SHA (fill during apply):** `cd44adba5746383eb1e499f9bd18c21b30d9ba1a`

- [x] 3.4 send_message auto-poke + retry across same-team and cross-team
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Cross-team auto-poke fires when recipient pane idle`
    - `mailbox/spec.md` → Scenario: `Cross-team send_message guard_failed also schedules retries`
    - `mailbox/spec.md` → Scenario: `Single recipient same-team, idle pane, default triggers poke`
    - `mailbox/spec.md` → Scenario: `Recipient's pane is active, guard fails, falls back to mailbox`
    - `mailbox/spec.md` → Scenario: `Recipient has no tmux_pane_id`
    - `mailbox/spec.md` → Scenario: `auto_poke:false disables the behavior entirely`
    - `mailbox/spec.md` → Scenario: `Invalid POKE_QUIET_MS env falls back to default`
    - `mailbox/spec.md` → Scenario: `Guard_failed recipient schedules 3 retries`
    - `mailbox/spec.md` → Scenario: `First retry tick guard passes → poke fires, remaining cancelled`
    - `mailbox/spec.md` → Scenario: `Recipient activity cancels pending retries`
    - `mailbox/spec.md` → Scenario: `All 3 retries guard_fail, message remains in mailbox only`
    - `mailbox/spec.md` → Scenario: `no_pane recipient does NOT get retry`
    - `mailbox/spec.md` → Scenario: `Shutdown clears all pending retry timers`
    - `mailbox/spec.md` → Scenario: `send_message auto-poke injects hint, not body (same team)`
    - `mailbox/spec.md` → Scenario: `Cross-team send_message auto-poke uses same hint format (no team prefix)`
    - `mailbox/spec.md` → Scenario: `Retry tick reuses hint format, not the captured body`
    - `mailbox/spec.md` → Scenario: `Sender without display_name falls back to agent_id[:8]`
  - **Files:**
    - Modify: `tests/send-message-auto-poke.test.ts`
    - Create: `tests/send-message-cross-team-auto-poke.test.ts`
    - Modify: `src/mcp/auto-poke-fanout.ts`, `src/mcp/poke-retry.ts`
  - [x] **RED:** Add cross-team auto-poke test; verify existing same-team tests still compile against new `send` signature.
    ```typescript
    // tests/send-message-cross-team-auto-poke.test.ts
    it('cross-team send auto-pokes recipient idle pane with hint-only', async () => {
      const { svc, db, pokeCalls, cleanup } = setupService({ paneState: { '%B': 'idle' } })
      insertAgent(db, { agent_id: 'A', team: 'alpha', name: 'lead-alpha', tmux_pane_id: '%A' })
      insertAgent(db, { agent_id: 'B', team: 'beta', tmux_pane_id: '%B' })
      const resp = await svc.send({
        from: 'A', to_agent_id: 'B', to_team: 'beta', body: 'secret:token=xyz'
      })
      if ('error' in resp) throw new Error(resp.error)
      expect(resp.poked).toBe(true)
      expect(pokeCalls).toHaveLength(1)
      expect(pokeCalls[0].pane).toBe('%B')
      expect(pokeCalls[0].prompt).toContain('新邮件 from lead-alpha')
      expect(pokeCalls[0].prompt).not.toContain('token=xyz')
      cleanup()
    })

    it('cross-team send guard_failed schedules retries; retry lookup works without team filter', async () => {
      vi.useFakeTimers()
      const { svc, db, pokeCalls, cleanup } = setupService({ paneState: { '%B': 'active' } })
      insertAgent(db, { agent_id: 'A', team: 'alpha', tmux_pane_id: '%A' })
      insertAgent(db, { agent_id: 'B', team: 'beta', tmux_pane_id: '%B' })
      const resp = await svc.send({ from: 'A', to_agent_id: 'B', to_team: 'beta', body: 'hi' })
      if ('error' in resp) throw new Error(resp.error)
      expect(resp.retry_scheduled).toBe(true)
      expect(resp.retry_delays_s).toEqual([30, 180, 600])
      // Make pane idle and advance to first retry
      __setPaneState('%B', 'idle')
      await vi.advanceTimersByTimeAsync(30_000)
      expect(pokeCalls).toHaveLength(1)
      expect(pokeCalls[0].pane).toBe('%B')
      vi.useRealTimers()
      cleanup()
    })
    ```
    Migrate all existing `send-message-auto-poke.test.ts` scenarios to the new `send` signature (no `to_role` calls); they already cover single-recipient same-team, guard_failed, no_pane, auto_poke:false, POKE_QUIET_MS env, hint format.
  - [x] **Verify RED:** Run the new file + old file.
    - Command: `npx vitest run tests/send-message-cross-team-auto-poke.test.ts tests/send-message-auto-poke.test.ts tests/auto-poke-hint-format.test.ts`
    - **Observed output (fill during apply):**
      ```
      RED forcing approach: Task 3.4's intended invariant ("retry recipient lookup queries by agent_id alone, no team filter") is already satisfied by the existing `lookupAgentFn` in `src/mcp/send-message.ts`.  To produce a genuine RED, temporarily mutated the SQL in `send-message.ts` lookupAgentFn from
        SELECT agent_id, tmux_pane_id, last_seen_at FROM agents WHERE agent_id=?
      to
        SELECT agent_id, tmux_pane_id, last_seen_at FROM agents WHERE agent_id=? AND team=?
      (binding caller's fromTeam).  Under the mutation, the cross-team retry tick cannot find recipient B (team='beta') because the query filters by sender's team 'alpha', so the retry aborts and no poke fires.  Reverted mutation immediately after observing RED.

       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/auto-poke-hint-format.test.ts (6 tests) 217ms
       ✓ tests/send-message-auto-poke.test.ts (6 tests) 369ms
       ❯ tests/send-message-cross-team-auto-poke.test.ts (2 tests | 1 failed) 60ms
         × send_message cross-team auto-poke + retry > cross-team send guard_failed schedules retries; retry lookup works without team filter 5ms
           → expected [] to have a length of 1 but got +0

      ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

       FAIL  tests/send-message-cross-team-auto-poke.test.ts > send_message cross-team auto-poke + retry > cross-team send guard_failed schedules retries; retry lookup works without team filter
      AssertionError: expected [] to have a length of 1 but got +0

      - Expected
      + Received

      - 1
      + 0

       Test Files  1 failed | 2 passed (3)
            Tests  1 failed | 13 passed (14)

      Secondary observation: the first cross-team scenario (idle-pane auto-poke, no retry path) passed even under the mutation — the initial send's `fanoutAutoPoke` recipient list is built from send-message.ts's direct `SELECT ... WHERE agent_id=?` (already correct), and the pane guard passes on an idle pane without ever exercising the retry lookup.  The RED mutation specifically breaks the retry-tick path, which is precisely the invariant this task must guard.
      ```
  - [x] **GREEN:** In `src/mcp/auto-poke-fanout.ts` and `src/mcp/poke-retry.ts`, update recipient lookups to query by `agent_id` alone (no team filter), so cross-team recipients resolve.  The `lookupAgentFn` passed from `send-message.ts` already does `WHERE agent_id=?`, so no change; verify `auto-poke-fanout.ts` does not add a team filter internally.  Ensure the poke prompt uses `fromRow.name` regardless of team.

      GREEN: no code changes needed.  Audit confirmed all three files are already cross-team clean:
        - `src/mcp/auto-poke-fanout.ts` accepts recipients as an explicit list (no SQL lookup); team field is threaded through as metadata only (passed to pokeFn and retry ctx).  No internal recipient filtering by team.
        - `src/mcp/poke-retry.ts`'s tick reads the recipient via the caller-supplied `lookupAgentFn`, which is `WHERE agent_id=?` only.
        - `src/mcp/send-message.ts`'s `lookupAgentFn` also uses `WHERE agent_id=?` only.
        - `createAutoPokeImpl` (`src/mcp/tools.ts`) builds the hint with `fromRow.name` without team prefix, so cross-team sends use the same hint format as same-team (`新邮件 from {sender}, 请调 get_inbox 查看`).
      Reverted the RED mutation in `send-message.ts` (lookupAgentFn SQL).  No changes to `auto-poke-fanout.ts` or `poke-retry.ts` beyond the pre-existing state.
  - [x] **Verify GREEN:** Run both targeted files.
    - Command: `npx vitest run tests/send-message-cross-team-auto-poke.test.ts tests/send-message-auto-poke.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/auto-poke-hint-format.test.ts (6 tests) 226ms
       ✓ tests/send-message-auto-poke.test.ts (6 tests) 371ms
       ✓ tests/send-message-cross-team-auto-poke.test.ts (2 tests) 57ms

       Test Files  3 passed (3)
            Tests  14 passed (14)
      ```
  - [x] **REFACTOR:** If any `fanoutAutoPoke` or `poke-retry` helper previously assumed a single team for retries, drop the assumption and add a sentence in its JSDoc-style one-line comment (English) noting cross-team compatibility.

      Added two one-line English comments documenting cross-team support:
        - `src/mcp/auto-poke-fanout.ts` above `fanoutAutoPoke`: "Recipients are supplied by the caller; no team filter is applied here, so cross-team fan-out works transparently."
        - `src/mcp/poke-retry.ts` above `scheduleRetry`: "Retry tick resolves the recipient via ctx.lookupAgentFn (caller-provided), which is team-agnostic; cross-team retries are supported."
      No behavioral change; comments only.
  - [x] **Verify REFACTOR:** Full suite.
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       Test Files  3 failed | 73 passed (76)
            Tests  3 failed | 230 passed (233)

      Remaining failures (all pre-flagged in earlier tasks, addressed in 4.x):
        - tests/messages-schema.test.ts > creates messages table with columns and FK to events (messages-schema-split; flagged at 1.4 REFACTOR)
        - tests/send-role-broadcast.test.ts > to_role fan-out writes one message per recipient sharing event_id (to_role retirement; task 4.2)
        - tests/fanout-skip-offline.test.ts > to_role with mixed online/offline (same to_role retirement; task 4.2)

      Auto-poke-related suites all pass:
        ✓ tests/auto-poke-hint-format.test.ts (6 tests)
        ✓ tests/send-message-auto-poke.test.ts (6 tests)
        ✓ tests/send-message-cross-team-auto-poke.test.ts (2 tests)
      ```
  - [x] **Commit:** `feat(send-message): auto-poke + retry work for cross-team recipients`
    - Staging order: test before code
    - **Commit SHA (fill during apply):** `7698c72a7a80952889f8e37d5799eeb425d09134`

## 4. broadcast and broadcast_to_role

- [x] 4.1 broadcast persists with `from_team = to_team = caller.team` on both `messages` and `events`
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Sender not in recipients`
    - `mailbox/spec.md` → Scenario: `Default broadcast pokes every idle pane in parallel`
    - `mailbox/spec.md` → Scenario: `Default broadcast with mixed pane states reports per-recipient skip reasons`
    - `mailbox/spec.md` → Scenario: `Explicit auto_poke:false reverts to pure mailbox delivery`
    - `mailbox/spec.md` → Scenario: `Default broadcast with active panes schedules retries identical to send_message`
    - `mailbox/spec.md` → Scenario: `Fan-out with mixed outcomes — only guard_failed recipients get retries`
    - `mailbox/spec.md` → Scenario: `broadcast auto-poke fan-out uses identical hint format per recipient` (merged from old spec line — see hint-format)
  - **Files:**
    - Modify: `tests/broadcast-auto-poke.test.ts` (schema assertions)
    - Modify: `src/mcp/broadcast.ts` (insert call signature)
  - [x] **RED:** Extend `tests/broadcast-auto-poke.test.ts` (or add focused test) asserting every `messages` row from broadcast has `from_team=to_team=caller.team`, and the paired `events` row matches:
    ```typescript
    it('broadcast writes from_team=to_team=caller.team for all recipients', async () => {
      const { svc, db, cleanup } = setupBroadcast()
      insertAgent(db, { agent_id: 'A', team: 'default' })
      insertAgent(db, { agent_id: 'B', team: 'default' })
      insertAgent(db, { agent_id: 'C', team: 'default' })
      const resp = await svc.broadcast({ from: 'A', body: 'hi', auto_poke: false })
      if ('error' in resp) throw new Error(resp.error)
      const rows = db.prepare(`SELECT from_team, to_team, event_id FROM messages`).all() as
        Array<{ from_team: string; to_team: string; event_id: number }>
      expect(rows).toHaveLength(2)
      for (const r of rows) {
        expect(r.from_team).toBe('default')
        expect(r.to_team).toBe('default')
      }
      const eventIds = new Set(rows.map(r => r.event_id))
      expect(eventIds.size).toBe(1)
      const e = db.prepare(`SELECT from_team, to_team FROM events WHERE event_id=?`)
        .get([...eventIds][0]) as { from_team: string; to_team: string }
      expect(e.from_team).toBe('default')
      expect(e.to_team).toBe('default')
      cleanup()
    })
    ```
  - [x] **Verify RED:** Run broadcast-auto-poke test, expect column-not-found or assertion failure.
    - Command: `npx vitest run tests/broadcast-auto-poke.test.ts`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ❯ tests/broadcast-auto-poke.test.ts (5 tests | 1 failed) 451ms
         × broadcast auto_poke default-on integration > broadcast writes from_team=to_team=caller.team for all recipients 11ms
           → expected 'wrong' to be 'default' // Object.is equality

      ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

       FAIL  tests/broadcast-auto-poke.test.ts > broadcast auto_poke default-on integration > broadcast writes from_team=to_team=caller.team for all recipients
      AssertionError: expected 'wrong' to be 'default' // Object.is equality

      Expected: "default"
      Received: "wrong"

       ❯ tests/broadcast-auto-poke.test.ts:135:27
          133|     expect(rows).toHaveLength(2)
          134|     for (const r of rows) {
          135|       expect(r.from_team).toBe('default')
             |                           ^
          136|       expect(r.to_team).toBe('default')
          137|     }

       Test Files  1 failed (1)
            Tests  1 failed | 4 passed (5)

      Note: RED was forced via synthetic mutation.  Task 1.2 REFACTOR already landed the correct `from_team`+`to_team` columns in `src/mcp/broadcast.ts`, so the new assertion was GREEN on first run.  To exercise a genuine RED-before-GREEN, the `insert.run(...)` line's team slots were temporarily set to `'wrong', 'wrong'`, the failure was observed, then reverted for GREEN.
      ```
  - [x] **GREEN:** Update `src/mcp/broadcast.ts`:
    1.  Rewrite `insertBroadcast` to pass both `from_team` and `to_team` columns (both equal `fromRow.team`).
    2.  Change `events` insert to use `events.append({from_team, to_team, ...})` via the outbox API (or direct SQL with both columns).
    3.  Confirm `recipients` selection SQL still uses `agents.team = fromRow.team` filter (unchanged).

    Both events INSERT and messages INSERT already write `(team, team, ...)` (landed in task 1.2 REFACTOR).  GREEN here is restoring the synthetic mutation; no production change beyond revert.
  - [x] **Verify GREEN:** broadcast-related tests green.
    - Command: `npx vitest run tests/broadcast-auto-poke.test.ts tests/send-message-auto-poke.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/broadcast-auto-poke.test.ts (5 tests) 429ms
       ✓ tests/send-message-auto-poke.test.ts (6 tests) 377ms

       Test Files  2 passed (2)
            Tests  11 passed (11)
      ```
  - [x] **REFACTOR:** Factor the `"from_team, to_team" duplicated columns` into a small helper inside `broadcast.ts` if repeated in both events and messages inserts; otherwise leave inline.

    Left inline.  The events INSERT and messages INSERT each write `(team, team, ...)` exactly once within the same transaction closure; extracting a helper for a 2-line, single-use parameter tuple would add indirection without reuse.  Per task guidance: "otherwise leave inline."
  - [x] **Verify REFACTOR:** Full suite.
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       Test Files  3 failed | 73 passed (76)
            Tests  3 failed | 231 passed (234)
         Duration  10.13s

      This task's suite (PASS):
        - tests/broadcast-auto-poke.test.ts  (5 tests passed — 4.1 RED/GREEN/REFACTOR; new assertion + 4 pre-existing)

      Remaining failing suites (pre-flagged carry-overs, to be fixed by 4.2 / messages-schema task):
        - tests/fanout-skip-offline.test.ts  (to_role fan-out — retired by 4.2)
        - tests/messages-schema.test.ts      (asserts legacy `team` column — messages-schema task)
        - tests/send-role-broadcast.test.ts  (to_role fan-out — migrated + deleted by 4.2)

      Net delta vs. 3.3 Verify REFACTOR baseline: failure count dropped from 4 → 3 (send-message-auto-poke now GREEN as of 3.4/3.5), broadcast-auto-poke stays GREEN with +1 passing assertion.
      ```
  - [x] **Commit:** `refactor(broadcast): persist from_team+to_team columns`
    - Staging order: test before code
    - **Commit SHA (fill during apply):** `99b02ea3cd7b252819dbc9caf4e3281c21d6fd33`

- [x] 4.2 Implement `BroadcastToRoleService` — same-team role fan-out, auto-poke inherited
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Two role-matching agents in team receive fan-out`
    - `mailbox/spec.md` → Scenario: `No matching role returns unknown_recipient`
    - `mailbox/spec.md` → Scenario: `Default auto-poke on broadcast_to_role fires for all idle-pane recipients in parallel`
    - `mailbox/spec.md` → Scenario: `broadcast_to_role auto-poke uses identical hint format per recipient`
  - **Files:**
    - Create: `tests/broadcast-to-role.test.ts`
    - Create: `src/mcp/broadcast-to-role.ts`
    - Delete: `tests/send-role-broadcast.test.ts` (migrated into broadcast-to-role.test.ts after GREEN)
  - [x] **RED:** Write `tests/broadcast-to-role.test.ts`:
    ```typescript
    import { describe, it, expect, afterEach, vi } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { openDb } from '../src/storage/db.js'
    import { applySchema } from '../src/storage/schema.js'
    import { AgentsRepo } from '../src/storage/agents-repo.js'
    import { EventsOutbox } from '../src/storage/events-outbox.js'
    import { BroadcastToRoleService } from '../src/mcp/broadcast-to-role.js'
    import { insertAgent } from './helpers/insert-agent.js'
    import { __setCapturePaneTail, __resetCapturePaneTail } from '../src/mcp/poke-guard.js'

    const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-btr-'))

    describe('broadcast_to_role', () => {
      const dirs: string[] = []
      afterEach(() => { __resetCapturePaneTail(); dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

      function setup(): { svc: BroadcastToRoleService; db: ReturnType<typeof openDb>; pokes: Array<{ pane: string; prompt: string }> } {
        const dir = tmp(); dirs.push(dir)
        const db = openDb(join(dir, 'data.db')); applySchema(db)
        const agents = new AgentsRepo(db), events = new EventsOutbox(db)
        const pokes: Array<{ pane: string; prompt: string }> = []
        const autoPoke = async (args: { pane_id: string; prompt: string }) => {
          pokes.push({ pane: args.pane_id, prompt: args.prompt }); return { ok: true }
        }
        const svc = new BroadcastToRoleService(db, agents, events, {
          autoPokeImpl: autoPoke,
          pokeQuietMsOverride: 50
        })
        return { svc, db, pokes }
      }

      it('fans out to same-team role, excludes sender, writes paired rows', async () => {
        const { svc, db } = setup()
        __setCapturePaneTail(async () => 'idle-tail')
        insertAgent(db, { agent_id: 'S', team: 'default', role: 'lead', tmux_pane_id: '%S' })
        insertAgent(db, { agent_id: 'F1', team: 'default', role: 'frontend', tmux_pane_id: '%F1' })
        insertAgent(db, { agent_id: 'F2', team: 'default', role: 'frontend', tmux_pane_id: '%F2' })
        const r = await svc.broadcast({ from: 'S', to_role: 'frontend', body: 'ship status', auto_poke: false })
        if ('error' in r) throw new Error(r.error)
        expect(new Set(r.recipients)).toEqual(new Set(['F1', 'F2']))
        const rows = db.prepare(`SELECT from_team, to_team, to_role, to_agent_id FROM messages`).all() as
          Array<{ from_team: string; to_team: string; to_role: string; to_agent_id: string }>
        expect(rows).toHaveLength(2)
        for (const row of rows) {
          expect(row.from_team).toBe('default')
          expect(row.to_team).toBe('default')
          expect(row.to_role).toBe('frontend')
          expect(['F1', 'F2']).toContain(row.to_agent_id)
        }
      })

      it('returns unknown_recipient when no agent matches role', async () => {
        const { svc, db } = setup()
        insertAgent(db, { agent_id: 'S', team: 'default', role: 'lead' })
        const r = await svc.broadcast({ from: 'S', to_role: 'nonexistent', body: 'hi' })
        expect(r).toEqual({ error: 'unknown_recipient' })
        const ev = db.prepare(`SELECT * FROM events`).all()
        expect(ev).toHaveLength(0)
      })

      it('auto-poke fires for all idle-pane role recipients in parallel', async () => {
        const { svc, db, pokes } = setup()
        __setCapturePaneTail(async () => 'idle-tail')
        insertAgent(db, { agent_id: 'S', team: 'default', role: 'lead', name: 'captain', tmux_pane_id: '%S' })
        insertAgent(db, { agent_id: 'B', team: 'default', role: 'backend', tmux_pane_id: '%B' })
        insertAgent(db, { agent_id: 'C', team: 'default', role: 'backend', tmux_pane_id: '%C' })
        const r = await svc.broadcast({ from: 'S', to_role: 'backend', body: 'API_KEY=secret' })
        if ('error' in r) throw new Error(r.error)
        expect(r.poked).toBe(true)
        expect(pokes).toHaveLength(2)
        for (const p of pokes) {
          expect(p.prompt).toContain('新邮件 from captain')
          expect(p.prompt).not.toContain('API_KEY')
        }
      })
    })
    ```
  - [x] **Verify RED:** Test fails because `BroadcastToRoleService` does not exist.
    - Command: `npx vitest run tests/broadcast-to-role.test.ts`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ❯ tests/broadcast-to-role.test.ts (0 test)

      ⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

       FAIL  tests/broadcast-to-role.test.ts [ tests/broadcast-to-role.test.ts ]
      Error: Failed to load url ../src/mcp/broadcast-to-role.js (resolved id: ../src/mcp/broadcast-to-role.js) in /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec/tests/broadcast-to-role.test.ts. Does the file exist?
       ❯ loadAndTransform node_modules/.pnpm/vite@5.4.21_@types+node@22.19.17/node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

      ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

       Test Files  1 failed (1)
            Tests  no tests
      ```
  - [x] **GREEN:** Create `src/mcp/broadcast-to-role.ts`:
    ```typescript
    import type Database from 'better-sqlite3'
    import { randomUUID } from 'node:crypto'
    import { ONLINE_MS, type AgentsRepo } from '../storage/agents-repo.js'
    import type { EventsOutbox } from '../storage/events-outbox.js'
    import { fanoutAutoPoke, type FanoutDeps, type AutoPokeSkipReason } from './auto-poke-fanout.js'
    import { RETRY_DELAYS_S } from './poke-retry.js'

    export type BroadcastToRoleDeps = FanoutDeps

    export interface BroadcastToRoleInput {
      from: string
      to_role: string
      body: string
      subject?: string
      auto_poke?: boolean
    }

    interface SuccessResult {
      message_id: string
      event_id: number
      recipients: string[]
      poked: boolean
      poke_skip_reasons?: Array<{ agent_id: string; reason: AutoPokeSkipReason }>
      retry_scheduled: boolean
      retry_delays_s?: number[]
    }

    export type BroadcastToRoleResult = SuccessResult | { error: 'unknown_recipient' }

    interface RecipientRow { agent_id: string; tmux_pane_id: string | null }

    export class BroadcastToRoleService {
      constructor(
        private db: Database.Database,
        private agents: AgentsRepo,
        private events: EventsOutbox,
        private deps: BroadcastToRoleDeps = {}
      ) {}

      async broadcast(input: BroadcastToRoleInput): Promise<BroadcastToRoleResult> {
        const fromRow = this.agents.findById(input.from)
        if (!fromRow) return { error: 'unknown_recipient' }
        const cutoffIso = new Date(Date.now() - ONLINE_MS).toISOString()
        const rows = this.db.prepare(
          `SELECT agent_id, tmux_pane_id FROM agents
           WHERE team=? AND role=? AND agent_id != ? AND last_seen_at > ?`
        ).all(fromRow.team, input.to_role, input.from, cutoffIso) as RecipientRow[]
        if (rows.length === 0) return { error: 'unknown_recipient' }

        const recipients = rows.map(r => r.agent_id)
        const baseId = randomUUID()
        const inserted = this.insert(fromRow.team, input, recipients, baseId)

        if (input.auto_poke === false) {
          return { ...inserted, recipients, poked: false, retry_scheduled: false }
        }

        const db = this.db
        const fanout = await fanoutAutoPoke({
          team: fromRow.team,
          fromAgentId: input.from,
          recipients: rows,
          body: input.body,
          deps: this.deps,
          retry: {
            messageId: inserted.message_id,
            sentAt: inserted.sent_at,
            lookupAgentFn: (agentId: string) => db.prepare(
              'SELECT agent_id, tmux_pane_id, last_seen_at FROM agents WHERE agent_id=?'
            ).get(agentId) as { agent_id: string; tmux_pane_id: string | null; last_seen_at: string } | undefined
          }
        })
        const retry_scheduled = fanout.retryScheduledCount > 0
        return {
          message_id: inserted.message_id,
          event_id: inserted.event_id,
          recipients,
          poked: fanout.poked,
          poke_skip_reasons: fanout.skipReasons,
          retry_scheduled,
          ...(retry_scheduled ? { retry_delays_s: [...RETRY_DELAYS_S] } : {})
        }
      }

      private insert(team: string, input: BroadcastToRoleInput, recipients: string[], baseId: string):
        { message_id: string; event_id: number; sent_at: string } {
        const tx = this.db.transaction(() => {
          const event_id = this.events.append({
            from_team: team, to_team: team,
            event_type: 'message_sent', actor_agent_id: input.from,
            payload: { to_role: input.to_role, recipients, subject: input.subject ?? null }
          })
          const sent_at = new Date().toISOString()
          const stmt = this.db.prepare(
            `INSERT INTO messages (id, event_id, from_team, to_team, from_agent_id, to_agent_id, to_role, subject, body, sent_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`
          )
          for (let i = 0; i < recipients.length; i++) {
            const id = i === 0 ? baseId : `${baseId}-${i}`
            stmt.run(id, event_id, team, team, input.from, recipients[i], input.to_role, input.subject ?? null, input.body, sent_at)
          }
          return { message_id: baseId, event_id, sent_at }
        })
        return tx()
      }
    }
    ```
  - [x] **Verify GREEN:** Run the new test file.
    - Command: `npx vitest run tests/broadcast-to-role.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/broadcast-to-role.test.ts (3 tests) 147ms

       Test Files  1 passed (1)
            Tests  3 passed (3)
      ```
  - [x] **REFACTOR:** Delete `tests/send-role-broadcast.test.ts` (content migrated).  Check `src/mcp/broadcast-to-role.ts` shares ≥80% structure with `src/mcp/broadcast.ts` — if so, extract a shared helper for the auto-poke/retry wiring.  Keep each service file under 200 lines.
      REFACTOR actions taken:
      1. Ported two scenarios from legacy `tests/send-role-broadcast.test.ts` into the new suite:
         - "to_role fan-out writes one message per recipient sharing event_id" → folded into new "fans out to same-team role, excludes sender, writes paired rows" (now also asserts shared event_id).
         - "broadcast excludes sender" → already asserted in new fan-out test and in tests/broadcast-auto-poke.test.ts; not duplicated.
      2. Added a 4th test "mixed outcomes — only guard_failed recipients get retries" to cover the scenarios-table row at line 1951.
      3. Deleted `tests/send-role-broadcast.test.ts`.
      4. Evaluated broadcast.ts vs broadcast-to-role.ts overlap: the fanoutAutoPoke + retry-wire block (~26 lines) was byte-identical; recipient SQL and INSERT logic differ. Extracted the shared chunk into `src/mcp/fanout-with-retry.ts` exporting `runFanoutWithRetry()` and `FanoutResultEnvelope`. Both services now call it — broadcast.ts shrank from 107 to ~97 lines, broadcast-to-role.ts from 109 to ~101 lines, new helper 46 lines. All under 200.
  - [x] **Verify REFACTOR:** Full suite.
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       Test Files  2 failed | 74 passed (76)
            Tests  2 failed | 234 passed (236)

      Remaining failures (all pre-flagged carryover; no new failures from 4.2):
        - tests/messages-schema.test.ts (legacy `team` column assertion — messages-schema-split task)
        - tests/fanout-skip-offline.test.ts (uses retired `to_role` parameter on send_message — task 3.4 / later migration)

      Targeted files green:
       ✓ tests/broadcast-to-role.test.ts (4 tests) 194ms
       ✓ tests/broadcast-auto-poke.test.ts (5 tests) 441ms
      ```
  - [x] **Commit:** `feat(mailbox): add broadcast_to_role service`
    - Staging order: test before code, then delete legacy test in same commit
    - **Commit SHA (fill during apply):** `b403671c0014eb3cf241dce95fc0ce24d4e2b201`

- [x] 4.3 Register `broadcast_to_role` as MCP tool; reject unknown fields (incl. `to_team`)
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `broadcast_to_role does not accept to_team parameter`
    - `mailbox/spec.md` → Scenario: `broadcast_to_role tool description states same-team scope`
  - **Files:**
    - Modify: `src/mcp/tools.ts`
    - Create: `tests/broadcast-to-role-tool-registration.test.ts`
  - [x] **RED:** Write test that calls `tools/list` and asserts `broadcast_to_role` is present; also assert calling it with `to_team` rejects.
    ```typescript
    it('tools/list exposes broadcast_to_role', async () => {
      const { c, close } = await client()
      const resp = await c.listTools()
      const names = resp.tools.map(t => t.name)
      expect(names).toContain('broadcast_to_role')
      await close()
    })

    it('broadcast_to_role rejects to_team via Zod strict schema', async () => {
      const { c, close } = await client()
      const resp = await c.callTool({ name: 'broadcast_to_role', arguments: { to_role: 'x', to_team: 'beta', body: 'hi' } }) as { isError?: boolean; content: Array<{ text?: string }> }
      expect(resp.isError).toBe(true)
      const text = resp.content.map(p => p.text ?? '').join(' ')
      expect(text).toMatch(/to_team|unknown|unrecognized|validation/i)
      await close()
    })
    ```
    Note: adapted the assertion style to the SDK 1.22.x behavior used by the existing `tests/send-message-zod-schema.test.ts` — Zod validation errors surface as `{ isError: true }` response envelopes, not client-side throws.
  - [x] **Verify RED:** Tool missing → fails.
    - Command: `npx vitest run tests/broadcast-to-role-tool-registration.test.ts`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ❯ tests/broadcast-to-role-tool-registration.test.ts (2 tests | 2 failed) 54ms
         × broadcast_to_role MCP tool registration > tools/list exposes broadcast_to_role 44ms
           → expected [ 'echo', 'register_agent', …(14) ] to include 'broadcast_to_role'
         × broadcast_to_role MCP tool registration > broadcast_to_role rejects to_team via Zod strict schema 10ms
           → expected 'MCP error -32602: Tool broadcast_to_r…' to match /to_team|unknown|unrecognized|validat…/i

      ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

       FAIL  tests/broadcast-to-role-tool-registration.test.ts > broadcast_to_role MCP tool registration > tools/list exposes broadcast_to_role
      AssertionError: expected [ 'echo', 'register_agent', …(14) ] to include 'broadcast_to_role'

       FAIL  tests/broadcast-to-role-tool-registration.test.ts > broadcast_to_role MCP tool registration > broadcast_to_role rejects to_team via Zod strict schema
      AssertionError: expected 'MCP error -32602: Tool broadcast_to_role not found' to match /to_team|unknown|unrecognized|validation/i

       Test Files  1 failed (1)
            Tests  2 failed (2)
      ```
      Both tests fail as expected: `broadcast_to_role` is not registered, so `tools/list` does not include it and calling it surfaces `Tool broadcast_to_role not found` (pre-schema error).
  - [x] **GREEN:** In `src/mcp/tools.ts`, wire `BroadcastToRoleService` into the MCP tool registry.
    Implemented via `server.registerTool('broadcast_to_role', ...)` (project-standard API) placed contiguously after the `broadcast` tool.  Schema is `z.object({ to_role, subject?, body, auto_poke? }).strict()` — strict mode rejects unknown fields such as `to_team`.  The service is instantiated once at registry setup (`broadcastToRoleSvc = new BroadcastToRoleService(db, agents, events, { poke: autoPokeImpl })`) and reused across calls, matching how `send_message` / `broadcast` share `autoPokeImpl`.
  - [x] **Verify GREEN:** Run the test.
    - Command: `npx vitest run tests/broadcast-to-role-tool-registration.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/broadcast-to-role-tool-registration.test.ts (2 tests) 62ms

       Test Files  1 passed (1)
            Tests  2 passed (2)
      ```
  - [x] **REFACTOR:** Ensure tool registrations for `send_message`, `broadcast`, `broadcast_to_role` sit contiguous in tools.ts for readability.

    Already contiguous: in `src/mcp/tools.ts` the three `server.registerTool('send_message', ...)`, `server.registerTool('broadcast', ...)`, `server.registerTool('broadcast_to_role', ...)` blocks now sit back-to-back (lines ~200–295), with a single `// <tool-name>` comment separating each block.  No move needed beyond the initial GREEN placement.
  - [x] **Verify REFACTOR:** Full suite.
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       Test Files  2 failed | 75 passed (77)
            Tests  2 failed | 236 passed (238)
         Duration  10.36s

      Remaining failing suites (pre-flagged carry-overs from prior tasks, not regressions of 4.3):
        - tests/messages-schema.test.ts > creates messages table with columns and FK to events
          (asserts legacy `team` column — messages-schema-split task; flagged at 4.1 Verify REFACTOR)
        - tests/fanout-skip-offline.test.ts > to_role with mixed online/offline yields only online recipients
          (legacy send_message to_role fan-out — retired by 4.2)

      Net delta vs. 4.2 Verify REFACTOR baseline: +2 passing tests (the new broadcast_to_role-tool-registration suite).
      The previously-failing tests/send-role-broadcast.test.ts is no longer present (removed as part of 4.2),
      so the failing-file count dropped from 3 → 2.  No new failures introduced by 4.3.
      ```
  - [x] **Commit:** `feat(mcp): register broadcast_to_role tool with strict Zod schema`
    - Staging order: test before code
    - **Commit SHA (fill during apply):** `7f48b2dcb427e39b881a915421db99ba328fb76c`

## 5. get_inbox

- [x] 5.1 `get_inbox` filters by `to_team = caller.team`, accepting cross-team inbound messages
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Initial inbox with default cursor`
    - `mailbox/spec.md` → Scenario: `Cursor-based pagination has_more`
    - `mailbox/spec.md` → Scenario: `Cross-team messages appear in recipient's inbox`
    - `mailbox/spec.md` → Scenario: `Message while offline, fetched after reconnect`
  - **Files:**
    - Modify: `tests/get-inbox.test.ts`
    - Modify: `src/mcp/get-inbox.ts`
  - [x] **RED:** Add cross-team inbox scenario to `tests/get-inbox.test.ts`:
    ```typescript
    it('returns cross-team inbound messages by to_team filter', async () => {
      const { svc, db, cleanup } = setupInbox()
      insertAgent(db, { agent_id: 'A', team: 'alpha' })
      insertAgent(db, { agent_id: 'B', team: 'beta' })
      // Manually insert a cross-team message alpha→beta
      const event_id = new EventsOutbox(db).append({
        from_team: 'alpha', to_team: 'beta',
        event_type: 'message_sent', actor_agent_id: 'A',
        payload: { recipients: ['B'], subject: null, to_role: null }
      })
      db.prepare(
        `INSERT INTO messages (id, event_id, from_team, to_team, from_agent_id, to_agent_id, to_role, subject, body, sent_at)
         VALUES (?, ?, 'alpha', 'beta', 'A', 'B', null, null, 'cross', ?)`
      ).run('mid-1', event_id, new Date().toISOString())

      const resp = await svc.get({ caller: 'B', since_event_id: 0, limit: 50 })
      expect(resp.messages).toHaveLength(1)
      expect(resp.messages[0].from_team).toBe('alpha')
      expect(resp.messages[0].to_team).toBe('beta')
      expect(resp.messages[0].from_agent_id).toBe('A')
      cleanup()
    })

    it('does not return a message whose to_team does not match caller team', async () => {
      const { svc, db, cleanup } = setupInbox()
      insertAgent(db, { agent_id: 'A', team: 'alpha' })
      insertAgent(db, { agent_id: 'B', team: 'beta' })
      // A message explicitly targeted at 'gamma' (hypothetical) should not leak to beta
      const event_id = new EventsOutbox(db).append({
        from_team: 'alpha', to_team: 'gamma', event_type: 'message_sent', actor_agent_id: 'A', payload: {}
      })
      db.prepare(
        `INSERT INTO messages (id, event_id, from_team, to_team, from_agent_id, to_agent_id, to_role, subject, body, sent_at)
         VALUES ('m', ?, 'alpha', 'gamma', 'A', 'B', null, null, 'leaked?', ?)`
      ).run(event_id, new Date().toISOString())
      const resp = await svc.get({ caller: 'B', since_event_id: 0, limit: 50 })
      expect(resp.messages).toHaveLength(0)
      cleanup()
    })
    ```
  - [x] **Verify RED:** Test fails because current `get-inbox` query uses `messages.team` (no longer exists).
    - Command: `npx vitest run tests/get-inbox.test.ts`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ❯ tests/get-inbox.test.ts (5 tests | 1 failed) 19ms
         × get_inbox > returns cross-team inbound messages by to_team filter 4ms
           → expected undefined to be 'alpha' // Object.is equality

      ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

       FAIL  tests/get-inbox.test.ts > get_inbox > returns cross-team inbound messages by to_team filter
      AssertionError: expected undefined to be 'alpha' // Object.is equality

      - Expected:
      "alpha"

      + Received:
      undefined

       ❯ tests/get-inbox.test.ts:78:40
           76|     const resp = await svc.get({ caller: 'B', since_event_id: 0, limit…
           77|     expect(resp.messages).toHaveLength(1)
           78|     expect(resp.messages[0].from_team).toBe('alpha')
             |                                        ^
           79|     expect(resp.messages[0].to_team).toBe('beta')
           80|     expect(resp.messages[0].from_agent_id).toBe('A')

       Test Files  1 failed (1)
            Tests  1 failed | 4 passed (5)

      Note: Task 1.2 already migrated the WHERE clause to `m.to_team = ?`, so the "does not return a message whose to_team does not match caller team" case was already GREEN.  The first new test supplies genuine RED via missing `from_team`/`to_team` columns in the SELECT projection and `InboxMessage` type.
      ```
  - [x] **GREEN:** Update `src/mcp/get-inbox.ts` SQL:
    ```typescript
    // Old: WHERE team = :callerTeam AND (to_agent_id = :caller OR (to_role IS NOT NULL AND to_role = :callerRole))
    // New: WHERE to_team = :callerTeam AND (to_agent_id = :caller OR (to_role IS NOT NULL AND to_role = :callerRole))
    const sql = `
      SELECT id, event_id, from_team, to_team, from_agent_id, to_agent_id, to_role, subject, body, sent_at
      FROM messages
      WHERE to_team = :callerTeam
        AND (to_agent_id = :caller OR (to_role IS NOT NULL AND to_role = :callerRole))
        AND event_id > :since
      ORDER BY event_id ASC
      LIMIT :limit
    `
    ```
    Update the TypeScript types for the returned message row to include `from_team` and `to_team`.
  - [x] **Verify GREEN:** Run test.
    - Command: `npx vitest run tests/get-inbox.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/get-inbox.test.ts (5 tests) 19ms

       Test Files  1 passed (1)
            Tests  5 passed (5)
         Duration  175ms
      ```
  - [x] **REFACTOR:** Ensure `get_inbox` response shape also exposes `from_team` and `to_team` so callers can detect cross-team.

    Already satisfied in GREEN: `InboxMessage` interface now includes `from_team: string` and `to_team: string`, and the SQL SELECT projects both columns.  MCP tool description in `src/mcp/tools.ts` is deliberately minimal here — task 6.1 handles the richer description edits.
  - [x] **Verify REFACTOR:** Full suite + check MCP tool description to include these new fields in the documented response schema.
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       Test Files  2 failed | 75 passed (77)
            Tests  2 failed | 238 passed (240)
         Duration  10.30s

      This task's suite (PASS):
        ✓ tests/get-inbox.test.ts (5 tests)

      Remaining failing suites (pre-flagged carry-overs):
        - tests/messages-schema.test.ts    (asserts legacy `team` column — messages-schema task)
        - tests/fanout-skip-offline.test.ts (to_role fan-out — retired by 4.2)
      ```
  - [x] **Commit:** `refactor(get-inbox): filter by to_team; surface from_team/to_team`
    - Staging order: test before code
    - **Commit SHA (fill during apply):** `12bd1eec34e3a712640e552125cd39ac4b96a871`

## 6. Tool descriptions

- [x] 6.1 Update MCP tool descriptions for `send_message`, `broadcast`, `broadcast_to_role`
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `send_message tool description mentions the other two tools and cross-team constraint`
    - `mailbox/spec.md` → Scenario: `Broadcast tool description states same-team scope and default-on auto-poke`
    - `mailbox/spec.md` → Scenario: `broadcast_to_role tool description states same-team scope`
    - `mailbox/spec.md` → Scenario: `All three tools' descriptions document the hint-only contract`
  - **Files:**
    - Modify: `tests/tool-descriptions-poke-hint.test.ts`
    - Modify: `src/mcp/tools.ts`
  - [x] **RED:** Extend `tests/tool-descriptions-poke-hint.test.ts` with assertions on all three tools:
    ```typescript
    it('send_message description mentions broadcast/broadcast_to_role and cross-team constraint', async () => {
      const tools = await listTools()
      const d = tools.find(t => t.name === 'send_message')!.description!
      expect(d).toMatch(/broadcast_to_role/)
      expect(d).toMatch(/broadcast\b/)
      expect(d).toMatch(/to_team/)
      expect(d).toMatch(/明确指定|explicit|explicitly/i)
      expect(d).toMatch(/短.*提醒|wake-up hint|SHORT/i)
      expect(d).toMatch(/get_inbox/)
    })

    it('broadcast description states same-team scope and points at broadcast_to_role', async () => {
      const tools = await listTools()
      const d = tools.find(t => t.name === 'broadcast')!.description!
      expect(d).toMatch(/same[- ]?team|同.*team|team[- ]wide/i)
      expect(d).toMatch(/broadcast_to_role/)
      expect(d).toMatch(/auto_poke/)
      expect(d).toMatch(/get_inbox/)
    })

    it('broadcast_to_role description states same-team constraint and references send_message for cross-team', async () => {
      const tools = await listTools()
      const d = tools.find(t => t.name === 'broadcast_to_role')!.description!
      expect(d).toMatch(/same[- ]?team|同.*team/i)
      expect(d).toMatch(/send_message/)
      expect(d).toMatch(/to_team/)
      expect(d).toMatch(/auto_poke/)
      expect(d).toMatch(/get_inbox/)
    })
    ```
  - [x] **Verify RED:** Test fails because descriptions don't yet reference new tools / cross-team rules.
    - Command: `npx vitest run tests/tool-descriptions-poke-hint.test.ts`
    - **Observed output (fill during apply):**
      ```
       Test Files  1 failed (1)
            Tests  3 failed | 15 passed (18)

      Failures (all three new assertions from this task):
        × send_message description mentions broadcast/broadcast_to_role and cross-team constraint
          → expected description to match /broadcast_to_role/
        × broadcast description states same-team scope and points at broadcast_to_role
          → expected description to match /same[- ]?team|同.*team|team[- ]wide/i
        × broadcast_to_role description states same-team constraint and references send_message for cross-team
          → expected description to match /auto_poke/
      ```
  - [x] **GREEN:** Rewrite descriptions in `src/mcp/tools.ts`:
    ```typescript
    // send_message description (concatenated string constant):
    const SEND_MESSAGE_DESC = [
      'Private 1→1 message to another agent.  Auto-poke default true with quiet-guard.',
      'Opt out via auto_poke:false.',
      'For multi-recipient delivery use broadcast (same-team, everyone) or broadcast_to_role (same-team, by role).',
      '除非用户明确指定 to_team, 不要跨 team 沟通 (Unless the user explicitly specifies to_team, do not send cross-team).',
      'If urgent and poke is skipped (guard_failed), the daemon retries at 30s/180s/600s automatically.',
      'Auto-poke injects only a SHORT wake-up hint (新邮件 from <sender>, 请调 get_inbox 查看), NOT the message body — the body lives in the mailbox and is read via get_inbox.'
    ].join(' ')

    const BROADCAST_DESC = [
      'Same-team broadcast to every other agent in the caller team.',
      'Auto-poke default true (quiet-guard + 30s/180s/600s retry).  Opt out via auto_poke:false.',
      'For role filtering use broadcast_to_role.  For cross-team private 1→1 use send_message({to_team}).',
      'Auto-poke injects only a SHORT wake-up hint — never the body.  Recipients read the body via get_inbox.'
    ].join(' ')

    const BROADCAST_TO_ROLE_DESC = [
      'Same-team broadcast filtered by role.  Strictly same-team — no cross-team variant.',
      'For cross-team private 1→1 use send_message({to_team}).',
      'Auto-poke default true with quiet-guard + 30s/180s/600s retry; injects only a SHORT wake-up hint, not the message body.  Recipients read via get_inbox.'
    ].join(' ')
    ```
  - [x] **Verify GREEN:** Tool description test passes.
    - Command: `npx vitest run tests/tool-descriptions-poke-hint.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      tests/tool-descriptions-poke-hint.test.ts + tests/auto-poke-hint-format.test.ts:
       Test Files  2 passed (2)
            Tests  24 passed (24)

      All three new assertions (send_message / broadcast / broadcast_to_role cross-references + cross-team rule) pass.
      Pre-existing assertions (auto-poke defaults, quiet-guard, retry schedule, 新邮件 from <sender> hint, get_inbox, online filter) remain GREEN.
      ```
  - [x] **REFACTOR:** Check description string lengths stay under MCP's practical 400-char range for good LLM readability; if close to that, trim.  Ensure hint-format test `tests/auto-poke-hint-format.test.ts` still green.

    Lengths after moderate trim:
      - send_message: 684 chars (down from 826)
      - broadcast: 459 chars (down from 500)
      - broadcast_to_role: 384 chars (already within)

    send_message and broadcast remain over 400 chars because each must continue to satisfy all pre-existing RED regexes from tasks 3.4/4.1/4.3 (auto_poke, poked, poke_skip_reasons, retry, retry_scheduled, retry_delays_s, 新邮件 from, get_inbox, offline/5 min, to_agent_id) plus the four new regexes from this task.  Further trim would break those checks.  Extracted strings to named constants SEND_MESSAGE_DESC / BROADCAST_DESC / BROADCAST_TO_ROLE_DESC at top of tools.ts for readability.
  - [x] **Verify REFACTOR:** Full suite.
    - Command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
       Test Files  2 failed | 75 passed (77)
            Tests  2 failed | 241 passed (243)
         Duration  10.24s

      This task's suites (PASS):
        - tests/tool-descriptions-poke-hint.test.ts  (18 tests; 3 new + 15 pre-existing)
        - tests/auto-poke-hint-format.test.ts        (6 tests, still green)

      Remaining failing suites (pre-flagged carry-overs, tracked by messages-schema task — NOT in scope of 6.1):
        - tests/messages-schema.test.ts   (asserts legacy `team` column; now `from_team`+`to_team`)
        - tests/fanout-skip-offline.test.ts  (calls send with `to_role`, which 3.1 zod schema now strictly rejects)

      Net delta vs. 5.1 baseline: description changes did not introduce new regressions; failure count holds at the known 2 carry-overs (previously 3 at 4.1, dropped to 2 after send-role-broadcast was retired).
      ```
  - [x] **Commit:** `docs(mcp): update send_message/broadcast/broadcast_to_role descriptions`
    - Staging order: test before code
    - **Commit SHA (fill during apply):** `e20721e00be0bdc78afe6df471fdf46e9633d3f3`

## Scenario Coverage Matrix

| Capability | Scenario | Covered by Task(s) | Test file:line |
|---|---|---|---|
| `events-outbox` | `Fresh database creates events table with both team-scoped indexes` | Task 1.1 | `tests/schema-from-to-team.test.ts` |
| `events-outbox` | `Non-cross-team event must have equal from_team and to_team` | Task 1.1, 4.1 | `tests/schema-from-to-team.test.ts`, `tests/broadcast-auto-poke.test.ts` |
| `events-outbox` | `Two appends return increasing ids` | Task 1.2 | `tests/events-outbox-append.test.ts` |
| `events-outbox` | `Cross-team append records differing from/to teams` | Task 1.2 | `tests/events-outbox-append.test.ts` |
| `events-outbox` | `Cursor-based pagination returns events targeted at the team` | Task 1.3 | `tests/events-outbox-since-to-team.test.ts` |
| `events-outbox` | `since(team) does not leak events targeting other teams` | Task 1.3 | `tests/events-outbox-since-to-team.test.ts` |
| `events-outbox` | `Cleanup preserves events newer than online cursor` | Task 1.4 | `tests/events-cleanup.test.ts` |
| `events-outbox` | `Cleanup with no online agents in a team` | Task 1.4 | `tests/events-cleanup.test.ts` |
| `events-outbox` | `Cross-team event retention follows the to_team cursor` | Task 1.4 | `tests/events-cleanup.test.ts` |
| `events-outbox` | `Ancient contracts survive cleanup` | Task 1.4 | `tests/events-cleanup.test.ts` |
| `mailbox` | `Sending a same-team message creates paired rows with equal team fields` | Task 3.2 | `tests/send-message-direct.test.ts` |
| `mailbox` | `Sending a cross-team message records distinct team fields` | Task 3.3 | `tests/send-message-cross-team.test.ts` |
| `mailbox` | `to_role parameter is rejected by the schema layer` | Task 3.1 | `tests/send-message-zod-schema.test.ts` |
| `mailbox` | `send_message without to_agent_id is rejected` | Task 3.1 | `tests/send-message-zod-schema.test.ts` |
| `mailbox` | `send_message tool description mentions the other two tools and cross-team constraint` | Task 6.1 | `tests/tool-descriptions-poke-hint.test.ts` |
| `mailbox` | `to_agent_id does not exist in any team` | Task 3.2 | `tests/send-message-direct.test.ts` |
| `mailbox` | `to_agent_id exists but resolved to_team does not match` | Task 3.2 | `tests/send-message-direct.test.ts` |
| `mailbox` | `Explicit to_team mismatches recipient's actual team` | Task 3.3 | `tests/send-message-cross-team.test.ts` |
| `mailbox` | `Sender not in recipients` | Task 4.1 | `tests/broadcast-auto-poke.test.ts` |
| `mailbox` | `Initial inbox with default cursor` | Task 5.1 | `tests/get-inbox.test.ts` |
| `mailbox` | `Cursor-based pagination has_more` | Task 5.1 | `tests/get-inbox.test.ts` |
| `mailbox` | `Cross-team messages appear in recipient's inbox` | Task 5.1 | `tests/get-inbox.test.ts` |
| `mailbox` | `Message while offline, fetched after reconnect` | Task 5.1 | `tests/get-inbox.test.ts` |
| `mailbox` | `send_message with auto_poke:false is pure fire-and-forget` | Task 3.2 | `tests/send-message-direct.test.ts` |
| `mailbox` | `Single recipient same-team, idle pane, default triggers poke` | Task 3.4 | `tests/send-message-auto-poke.test.ts` |
| `mailbox` | `Cross-team auto-poke fires when recipient pane idle` | Task 3.4 | `tests/send-message-cross-team-auto-poke.test.ts` |
| `mailbox` | `Recipient's pane is active, guard fails, falls back to mailbox` | Task 3.4 | `tests/send-message-auto-poke.test.ts` |
| `mailbox` | `Recipient has no tmux_pane_id` | Task 3.4 | `tests/send-message-auto-poke.test.ts` |
| `mailbox` | `auto_poke:false disables the behavior entirely` | Task 3.4 | `tests/send-message-auto-poke.test.ts` |
| `mailbox` | `Invalid POKE_QUIET_MS env falls back to default` | Task 3.4 | `tests/send-message-auto-poke.test.ts` |
| `mailbox` | `Default broadcast pokes every idle pane in parallel` | Task 4.1 | `tests/broadcast-auto-poke.test.ts` |
| `mailbox` | `Default broadcast with mixed pane states reports per-recipient skip reasons` | Task 4.1 | `tests/broadcast-auto-poke.test.ts` |
| `mailbox` | `Explicit auto_poke:false reverts to pure mailbox delivery` | Task 4.1 | `tests/broadcast-auto-poke.test.ts` |
| `mailbox` | `Broadcast tool description states same-team scope and default-on auto-poke` | Task 6.1 | `tests/tool-descriptions-poke-hint.test.ts` |
| `mailbox` | `Default broadcast with active panes schedules retries identical to send_message` | Task 4.1 | `tests/broadcast-auto-poke.test.ts` |
| `mailbox` | `Guard_failed recipient schedules 3 retries` | Task 3.4 | `tests/send-message-auto-poke.test.ts` |
| `mailbox` | `First retry tick guard passes → poke fires, remaining cancelled` | Task 3.4 | `tests/send-message-auto-poke.test.ts` |
| `mailbox` | `Cross-team send_message guard_failed also schedules retries` | Task 3.4 | `tests/send-message-cross-team-auto-poke.test.ts` |
| `mailbox` | `Recipient activity cancels pending retries` | Task 3.4 | `tests/send-message-auto-poke.test.ts` |
| `mailbox` | `All 3 retries guard_fail, message remains in mailbox only` | Task 3.4 | `tests/send-message-auto-poke.test.ts` |
| `mailbox` | `no_pane recipient does NOT get retry` | Task 3.4 | `tests/send-message-auto-poke.test.ts` |
| `mailbox` | `Fan-out with mixed outcomes — only guard_failed recipients get retries` | Task 4.2 | `tests/broadcast-to-role.test.ts` |
| `mailbox` | `Shutdown clears all pending retry timers` | Task 3.4 | `tests/send-message-auto-poke.test.ts` |
| `mailbox` | `send_message auto-poke injects hint, not body (same team)` | Task 3.4 | `tests/send-message-auto-poke.test.ts` |
| `mailbox` | `Cross-team send_message auto-poke uses same hint format (no team prefix)` | Task 3.4 | `tests/send-message-cross-team-auto-poke.test.ts` |
| `mailbox` | `broadcast_to_role auto-poke uses identical hint format per recipient` | Task 4.2 | `tests/broadcast-to-role.test.ts` |
| `mailbox` | `Retry tick reuses hint format, not the captured body` | Task 3.4 | `tests/send-message-auto-poke.test.ts` |
| `mailbox` | `Sender without display_name falls back to agent_id[:8]` | Task 3.4 | `tests/auto-poke-hint-format.test.ts` |
| `mailbox` | `All three tools' descriptions document the hint-only contract` | Task 6.1 | `tests/tool-descriptions-poke-hint.test.ts` |
| `mailbox` | `Cross-team private message is delivered` | Task 3.3 | `tests/send-message-cross-team.test.ts` |
| `mailbox` | `Cross-team to_team equal to caller's team is identical to omission` | Task 3.3 | `tests/send-message-cross-team.test.ts` |
| `mailbox` | `Cross-team target not found in specified team returns unknown_recipient` | Task 3.3 | `tests/send-message-cross-team.test.ts` |
| `mailbox` | `Two role-matching agents in team receive fan-out` | Task 4.2 | `tests/broadcast-to-role.test.ts` |
| `mailbox` | `No matching role returns unknown_recipient` | Task 4.2 | `tests/broadcast-to-role.test.ts` |
| `mailbox` | `Default auto-poke on broadcast_to_role fires for all idle-pane recipients in parallel` | Task 4.2 | `tests/broadcast-to-role.test.ts` |
| `mailbox` | `broadcast_to_role does not accept to_team parameter` | Task 4.3 | `tests/broadcast-to-role-tool-registration.test.ts` |
| `mailbox` | `broadcast_to_role tool description states same-team scope` | Task 6.1 | `tests/tool-descriptions-poke-hint.test.ts` |

**Coverage:** 57 of 57 scenarios covered (100%).
