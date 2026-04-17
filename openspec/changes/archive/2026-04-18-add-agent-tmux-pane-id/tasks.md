# Implementation Tasks — add-agent-tmux-pane-id

Ordered by dependency: storage layer (1) → repo layer (2) → MCP tool layer (3) → docs (4).  Each code task follows RED → GREEN → REFACTOR.  Docs are manual-verify.

## 1. Storage: add `tmux_pane_id` column to agents table

- [x] 1.1 Fresh database creates agents table with nine columns including `tmux_pane_id TEXT NULL`
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `Fresh database creates agents table with nine columns`
  - **Files:**
    - Edit: `tests/agents-schema.test.ts` (extend existing column assertion to include `tmux_pane_id`)
    - Edit: `src/storage/schema.ts` (append `, tmux_pane_id TEXT` to agents DDL)
  - [x] **RED:** Extend the existing test in `tests/agents-schema.test.ts` so the sorted columns list is:
    ```ts
    expect(names).toEqual([
      'agent_id','display_name','last_processed_event_id','last_seen_at','model','registered_at','role','team','tmux_pane_id'
    ])
    ```
    Add an additional assertion that the `tmux_pane_id` column has `notnull === 0`:
    ```ts
    const pane = cols.find(c => c.name === 'tmux_pane_id') as { notnull: number; type: string } | undefined
    expect(pane?.type).toBe('TEXT')
    expect(pane?.notnull).toBe(0)
    ```
  - [x] **Verify RED:** Run the test, confirm failure because the existing DDL only has 8 cols
    - Command: `pnpm exec vitest run tests/agents-schema.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      × tests/agents-schema.test.ts > agents schema > creates agents table with required columns
        → expected [ 'agent_id', 'display_name', …(6) ] to deeply equal [ 'agent_id', 'display_name', …(7) ]
      AssertionError: expected [ 'agent_id', 'display_name', …(6) ] to deeply equal [ 'agent_id', 'display_name', …(7) ]
      - Expected
      + Received
        Array [
          "agent_id",
          "display_name",
          "last_processed_event_id",
          "last_seen_at",
          "model",
          "registered_at",
          "role",
          "team",
      -   "tmux_pane_id",
        ]
       ❯ tests/agents-schema.test.ts:20:19
       Test Files  1 failed (1)
            Tests  1 failed (1)
      ```
  - [x] **GREEN:** Append `tmux_pane_id TEXT` to the `CREATE TABLE IF NOT EXISTS agents` DDL in `src/storage/schema.ts`:
    ```ts
    `CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      team TEXT NOT NULL,
      role TEXT NOT NULL,
      display_name TEXT,
      model TEXT,
      registered_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_processed_event_id INTEGER NOT NULL DEFAULT 0,
      tmux_pane_id TEXT
    )`
    ```
  - [x] **Verify GREEN:** Re-run the test + full suite, confirm pass
    - Command: `pnpm exec vitest run tests/agents-schema.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/agents-schema.test.ts > agents schema > creates agents table with required columns
       Test Files  1 passed (1)
            Tests  1 passed (1)
         Duration  128ms
      Full suite:
       Test Files  41 passed (41)
            Tests  90 passed (90)
         Duration  2.30s
      ```
  - [x] **REFACTOR:** None — single-line DDL addition, already minimal
  - [x] **Verify REFACTOR:** Re-run same test
    - Command: `pnpm exec vitest run tests/agents-schema.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      REFACTOR step: no changes applied (already minimal).  Re-run of target test:
      ✓ tests/agents-schema.test.ts > agents schema > creates agents table with required columns
       Test Files  1 passed (1)
            Tests  1 passed (1)
      ```
  - [x] **Commit:** `feat(storage): add tmux_pane_id column to agents table`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `c421d86`

- [x] 1.2 Legacy database without `tmux_pane_id` auto-migrates on daemon bootstrap
  - kind: integration-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `Legacy database auto-migrates by adding tmux_pane_id column`
  - **Files:**
    - Create: `tests/agents-legacy-migration.test.ts`
    - Edit: `src/storage/schema.ts` (add migration helper that runs after initial DDL)
  - [x] **INTEGRATION-RED:** Write failing test — `tests/agents-legacy-migration.test.ts`
    ```ts
    import { describe, it, expect, afterEach } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { openDb } from '../src/storage/db.js'
    import { applySchema } from '../src/storage/schema.js'

    const tmp = () => mkdtempSync(join(tmpdir(), 'atm-legacy-'))

    describe('agents legacy migration', () => {
      const cleanups: string[] = []
      afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

      it('adds tmux_pane_id column to a legacy agents table without it', () => {
        const dir = tmp(); cleanups.push(dir)
        const db = openDb(join(dir, 'data.db'))

        // Simulate legacy schema: 8-column agents table
        db.exec(`CREATE TABLE agents (
          agent_id TEXT PRIMARY KEY,
          team TEXT NOT NULL,
          role TEXT NOT NULL,
          display_name TEXT,
          model TEXT,
          registered_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          last_processed_event_id INTEGER NOT NULL DEFAULT 0
        )`)
        db.prepare(`INSERT INTO agents (agent_id, team, role, registered_at, last_seen_at)
                    VALUES (?,?,?,?,?)`).run('legacy-a','default','backend','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')

        applySchema(db)

        const cols = db.pragma('table_info(agents)') as Array<{ name: string }>
        expect(cols.map(c => c.name)).toContain('tmux_pane_id')
        const row = db.prepare(`SELECT tmux_pane_id FROM agents WHERE agent_id='legacy-a'`).get() as { tmux_pane_id: string | null }
        expect(row.tmux_pane_id).toBeNull()

        // Idempotent — running applySchema again must not error nor duplicate
        expect(() => applySchema(db)).not.toThrow()
        db.close()
      })
    })
    ```
  - [x] **Verify INTEGRATION-RED:** Run test, confirm it fails (applySchema currently uses `CREATE TABLE IF NOT EXISTS`, so the existing legacy table is kept and no column is added)
    - Command: `pnpm exec vitest run tests/agents-legacy-migration.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      × tests/agents-legacy-migration.test.ts > agents legacy migration > adds tmux_pane_id column to a legacy agents table without it
        → expected [ 'agent_id', 'team', 'role', …(5) ] to include 'tmux_pane_id'
      AssertionError: expected [ 'agent_id', 'team', 'role', …(5) ] to include 'tmux_pane_id'
       ❯ tests/agents-legacy-migration.test.ts:34:35
           32|
           33|     const cols = db.pragma('table_info(agents)') as Array<{ name: stri…
           34|     expect(cols.map(c => c.name)).toContain('tmux_pane_id')
             |                                   ^
       Test Files  1 failed (1)
            Tests  1 failed (1)
      ```
  - [x] **INTEGRATION-GREEN:** Extend `src/storage/schema.ts` `applySchema` to run an idempotent column-add after the DDL:
    ```ts
    export function applySchema(db: Database.Database): void {
      for (const sql of DDL) db.exec(sql)
      ensureAgentsHasTmuxPaneId(db)
    }

    function ensureAgentsHasTmuxPaneId(db: Database.Database): void {
      const cols = db.pragma('table_info(agents)') as Array<{ name: string }>
      if (!cols.some(c => c.name === 'tmux_pane_id')) {
        db.exec(`ALTER TABLE agents ADD COLUMN tmux_pane_id TEXT`)
      }
    }
    ```
  - [x] **Verify INTEGRATION-GREEN:** Re-run test + full suite
    - Command: `pnpm exec vitest run tests/agents-legacy-migration.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/agents-legacy-migration.test.ts > agents legacy migration > adds tmux_pane_id column to a legacy agents table without it
       Test Files  1 passed (1)
            Tests  1 passed (1)
         Duration  130ms
      Full suite:
       Test Files  42 passed (42)
            Tests  91 passed (91)
         Duration  2.21s
      ```
  - [x] **REFACTOR:** Confirm `ensureAgentsHasTmuxPaneId` is the only post-DDL migration hook; rename if more migrations emerge.  None this change.
  - [x] **Verify REFACTOR:** Re-run integration + unit tests
    - Command: `pnpm exec vitest run tests/agents-legacy-migration.test.ts tests/agents-schema.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/agents-legacy-migration.test.ts > agents legacy migration > adds tmux_pane_id column to a legacy agents table without it
      ✓ tests/agents-schema.test.ts > agents schema > creates agents table with required columns
       Test Files  2 passed (2)
            Tests  2 passed (2)
         Duration  129ms
      ```
  - [x] **Commit:** `feat(storage): auto-migrate legacy agents table with tmux_pane_id column`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `2b107c1`

## 2. Repository: persist + upsert + select `tmux_pane_id`

- [x] 2.1 `AgentsRepo.register` accepts and persists `tmux_pane_id` when provided
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `New session registers with tmux_pane_id provided`
  - **Files:**
    - Create: `tests/agents-repo.test.ts` (if does not exist, otherwise Edit)
    - Edit: `src/storage/agents-repo.ts` (extend `RegisterInput`, INSERT SQL, and UPSERT SQL)
  - [x] **RED:** Add test case (added as a new `describe('AgentsRepo tmux_pane_id', ...)` block in the existing `tests/agents-repo.test.ts`)
  - [x] **Verify RED:** Run test, confirm failure (TypeScript error on `tmux_pane_id` not in `RegisterInput`, or runtime column not written)
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      × tests/agents-repo.test.ts > AgentsRepo tmux_pane_id > persists tmux_pane_id when provided
        → expected null to be '%42' // Object.is equality
      AssertionError: expected null to be '%42' // Object.is equality
      - Expected:
      "%42"
      + Received:
      null
       ❯ tests/agents-repo.test.ts:80:30
       Test Files  1 failed (1)
            Tests  1 failed | 4 passed (5)
      ```
  - [x] **GREEN:** Extend `RegisterInput` with `tmux_pane_id?: string`, extend INSERT SQL to include the column and bind:
    ```ts
    export interface RegisterInput {
      agent_id: string
      model: string
      role: string
      display_name?: string
      team?: string
      tmux_pane_id?: string
    }
    // ... inside register():
    this.db.prepare(
      `INSERT INTO agents (agent_id, team, role, display_name, model, registered_at, last_seen_at, tmux_pane_id)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(agent_id) DO UPDATE SET
         team=excluded.team,
         role=excluded.role,
         display_name=excluded.display_name,
         model=excluded.model,
         last_seen_at=excluded.last_seen_at,
         tmux_pane_id=COALESCE(excluded.tmux_pane_id, agents.tmux_pane_id)`
    ).run(
      input.agent_id, team, input.role, input.display_name ?? null, input.model, now, now, input.tmux_pane_id ?? null
    )
    ```
    Note: `COALESCE(excluded.tmux_pane_id, agents.tmux_pane_id)` preserves the existing value when the new row's pane is NULL (omitted in input).
  - [x] **Verify GREEN:** Re-run the test
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/agents-repo.test.ts > agents repo > register uses session id as agent_id and returns { agent_id, team }
      ✓ tests/agents-repo.test.ts > agents repo > repeated register upserts metadata
      ✓ tests/agents-repo.test.ts > agents repo > list_agents returns only caller team
      ✓ tests/agents-repo.test.ts > agents repo > online flag is true when last_seen_at within 5 minutes
      ✓ tests/agents-repo.test.ts > AgentsRepo tmux_pane_id > persists tmux_pane_id when provided
       Test Files  1 passed (1)
            Tests  5 passed (5)
      Full suite: Test Files  42 passed (42) / Tests  92 passed (92)
      ```
  - [x] **REFACTOR:** None
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      REFACTOR step: no changes (already minimal).  Target tests re-run:
       Test Files  1 passed (1)
            Tests  5 passed (5)
      ```
  - [x] **Commit:** `feat(agents-repo): persist tmux_pane_id via register`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `7d1f5d8`

- [x] 2.2 `AgentsRepo.register` without `tmux_pane_id` stores NULL
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `New session registers without tmux_pane_id`
    - `agent-registry/spec.md` → Scenario: `Missing tmux_pane_id persists as NULL`
    - `agent-registry/spec.md` → Scenario: `Non-tmux environment unaffected by new field`
  - **Files:**
    - Edit: `tests/agents-repo.test.ts`
  - [x] **RED:** Add test (regression-guard scenario; passes by construction after task 2.1's COALESCE implementation)
  - [x] **Verify RED:** Depending on task 2.1 completion; if 2.1 ran first, this should pass immediately (GREEN by construction from task 2.1).  Otherwise the test fails because INSERT SQL lacks the column.
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      Task 2.1 already landed the COALESCE-based INSERT before 2.2.  Test passes on first run as the task anticipated:
      ✓ tests/agents-repo.test.ts > AgentsRepo tmux_pane_id > stores NULL when tmux_pane_id is omitted
       Test Files  1 passed (1)
            Tests  6 passed (6)
      ```
  - [x] **GREEN:** Covered by task 2.1's implementation (COALESCE path stores NULL when input omits the field)
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/agents-repo.test.ts > AgentsRepo tmux_pane_id > stores NULL when tmux_pane_id is omitted
       Test Files  1 passed (1)
            Tests  6 passed (6)
         Duration  140ms
      ```
  - [x] **REFACTOR:** None
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      No refactor needed.  Target tests re-run passing:
       Test Files  1 passed (1)
            Tests  6 passed (6)
      ```
  - [x] **Commit:** `test(agents-repo): verify omitted tmux_pane_id defaults to NULL`
    - **Commit SHA (fill during apply):** `7caef90`

- [x] 2.3 Re-registering the same session with a new `tmux_pane_id` upserts the column
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `Same session re-registers with new tmux_pane_id`
  - **Files:**
    - Edit: `tests/agents-repo.test.ts`
  - [x] **RED:** Add test (upsert scenario; passes by construction after task 2.1's COALESCE UPSERT)
  - [x] **Verify RED:** Will pass if UPSERT uses `COALESCE(excluded.tmux_pane_id, agents.tmux_pane_id)` from task 2.1 (new non-NULL value replaces).  Prior to 2.1, column absent → test fails at SQL level.
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      Task 2.1 already applied the COALESCE UPSERT.  Test passes immediately as task anticipated:
      ✓ tests/agents-repo.test.ts > AgentsRepo tmux_pane_id > upserts tmux_pane_id when the same session re-registers
       Test Files  1 passed (1)
            Tests  7 passed (7)
      ```
  - [x] **GREEN:** Covered by task 2.1's COALESCE UPSERT clause
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/agents-repo.test.ts > AgentsRepo tmux_pane_id > upserts tmux_pane_id when the same session re-registers
       Test Files  1 passed (1)
            Tests  7 passed (7)
         Duration  136ms
      ```
  - [x] **REFACTOR:** None
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      No refactor.  Target test re-run:
       Test Files  1 passed (1)
            Tests  7 passed (7)
      ```
  - [x] **Commit:** `test(agents-repo): re-register upserts tmux_pane_id`
    - **Commit SHA (fill during apply):** `e163eee`

- [x] 2.4 Re-registering without `tmux_pane_id` preserves the existing persisted value
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `Same session re-registers omitting tmux_pane_id does not clear existing value`
  - **Files:**
    - Edit: `tests/agents-repo.test.ts`
  - [x] **RED:** Add test (preservation regression guard; passes by construction since task 2.1's COALESCE protects the column)
  - [x] **Verify RED:** Before COALESCE is applied, standard `excluded.tmux_pane_id` direct overwrite clears to NULL and the test fails.
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      Task 2.1's COALESCE already handles preservation.  Test passes on first run:
      ✓ tests/agents-repo.test.ts > AgentsRepo tmux_pane_id > preserves existing tmux_pane_id when re-register omits the field
       Test Files  1 passed (1)
            Tests  8 passed (8)
      ```
  - [x] **GREEN:** Task 2.1's `COALESCE(excluded.tmux_pane_id, agents.tmux_pane_id)` clause delivers this semantics
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/agents-repo.test.ts > AgentsRepo tmux_pane_id > preserves existing tmux_pane_id when re-register omits the field
       Test Files  1 passed (1)
            Tests  8 passed (8)
         Duration  151ms
      ```
  - [x] **REFACTOR:** None
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      No refactor.  Target test re-run:
       Test Files  1 passed (1)
            Tests  8 passed (8)
      ```
  - [x] **Commit:** `test(agents-repo): omitted tmux_pane_id on re-register preserves prior value`
    - **Commit SHA (fill during apply):** `00ad6bc`

- [x] 2.5 `AgentsRepo.list` returns `tmux_pane_id` for each agent (null when unset)
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `list_agents returns tmux_pane_id for each agent`
  - **Files:**
    - Edit: `tests/agents-repo.test.ts`
    - Edit: `src/storage/agents-repo.ts` (extend SELECT + `AgentListRow`)
  - [x] **RED:** Add test (appended to `AgentsRepo tmux_pane_id` describe block in `tests/agents-repo.test.ts`)
  - [x] **Verify RED:** Fails because `list` does not currently SELECT the column nor expose it in `AgentListRow`
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      × tests/agents-repo.test.ts > AgentsRepo tmux_pane_id > list returns tmux_pane_id for every agent (null when unset)
        → expected undefined to be '%42' // Object.is equality
      AssertionError: expected undefined to be '%42' // Object.is equality
      - Expected:
      "%42"
      + Received:
      undefined
       ❯ tests/agents-repo.test.ts:117:29
       Test Files  1 failed (1)
            Tests  1 failed | 8 passed (9)
      ```
  - [x] **GREEN:** Extend the SELECT and the `AgentListRow` interface
    ```ts
    export interface AgentListRow {
      agent_id: string
      role: string
      display_name: string | null
      model: string | null
      tmux_pane_id: string | null
      last_seen_at: string
      online: boolean
    }
    // ... in list():
    const rows = this.db.prepare(
      `SELECT agent_id, role, display_name, model, tmux_pane_id, last_seen_at FROM agents WHERE team=? ORDER BY registered_at ASC`
    ).all(args.team) as Array<{ agent_id: string; role: string; display_name: string | null; model: string | null; tmux_pane_id: string | null; last_seen_at: string }>
    const nowMs = Date.now()
    return rows.map(r => ({ ...r, online: nowMs - new Date(r.last_seen_at).getTime() < ONLINE_MS }))
    ```
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/agents-repo.test.ts > AgentsRepo tmux_pane_id > list returns tmux_pane_id for every agent (null when unset)
       Test Files  1 passed (1)
            Tests  9 passed (9)
      Full suite: Test Files  42 passed (42) / Tests  96 passed (96)
      ```
  - [x] **REFACTOR:** None
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      No refactor.  Target tests re-run:
       Test Files  1 passed (1)
            Tests  9 passed (9)
      ```
  - [x] **Commit:** `feat(agents-repo): expose tmux_pane_id in list rows`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `ba6153a`

- [x] 2.6 Opaque string format is preserved verbatim (no parsing / validation at storage layer)
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `Opaque string preserved regardless of format`
  - **Files:**
    - Edit: `tests/agents-repo.test.ts`
  - [x] **RED:** Add test (regression guard for opaque handling; passes by construction)
  - [x] **Verify RED:** Passes automatically once 2.1+2.5 are in (no format validation is added).  Kept as a regression guard.
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      Task 2.1 + 2.5 already deliver opaque pass-through.  Test passes on first run:
      ✓ tests/agents-repo.test.ts > AgentsRepo tmux_pane_id > stores non-tmux opaque strings verbatim
       Test Files  1 passed (1)
            Tests  10 passed (10)
      ```
  - [x] **GREEN:** Nothing to add; assert no format check exists in code
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/agents-repo.test.ts > AgentsRepo tmux_pane_id > stores non-tmux opaque strings verbatim
       Test Files  1 passed (1)
            Tests  10 passed (10)
         Duration  148ms
      ```
  - [x] **REFACTOR:** None
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      No refactor.  Target test re-run:
       Test Files  1 passed (1)
            Tests  10 passed (10)
      ```
  - [x] **Commit:** `test(agents-repo): preserve opaque tmux_pane_id values verbatim`
    - **Commit SHA (fill during apply):** `76f7119`

## 3. MCP tool layer: expose `tmux_pane_id` on register_agent input and list_agents output

- [x] 3.1 `register_agent` MCP tool accepts optional `tmux_pane_id` and forwards to the repo
  - kind: integration-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `New session registers with tmux_pane_id provided`
  - **Files:**
    - Create: `tests/register-agent-tmux-pane.test.ts`
    - Edit: `src/mcp/register-agent.ts` (extend `RegisterInput`)
    - Edit: `src/mcp/tools.ts` (add `tmux_pane_id: z.string().optional()` to `register_agent` inputSchema, pass through `args.tmux_pane_id`)
  - [x] **INTEGRATION-RED:** Write failing test against the MCP Streamable HTTP transport driving `register_agent` with `tmux_pane_id`, then asserting via `list_agents` response AND direct DB read that the value was persisted.
    ```ts
    import { describe, it, expect, afterEach } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { Client } from '@modelcontextprotocol/sdk/client/index.js'
    import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
    import { startServer } from '../src/daemon/server.js'
    import { openDb } from '../src/storage/db.js'
    import { applySchema } from '../src/storage/schema.js'

    const tmp = () => mkdtempSync(join(tmpdir(), 'atm-mcp-pane-'))

    describe('register_agent tmux_pane_id integration', () => {
      const cleanups: string[] = []
      afterEach(async () => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

      it('accepts tmux_pane_id and persists + exposes it', async () => {
        const dir = tmp(); cleanups.push(dir)
        const dbPath = join(dir, 'data.db')
        const { app, port } = await startServer({ dbPath, port: 0 })
        const url = new URL(`http://127.0.0.1:${port}/mcp`)
        const transport = new StreamableHTTPClientTransport(url)
        const client = new Client({ name: 'test', version: '0.0.0' })
        await client.connect(transport)

        const regResp = await client.callTool({
          name: 'register_agent',
          arguments: { model: 'opus-4-7', role: 'frontend', tmux_pane_id: '%42', team: 'default' }
        })
        const regText = (regResp.content as Array<{ text: string }>)[0].text
        const reg = JSON.parse(regText) as { agent_id?: string; error?: string }
        expect(reg.agent_id).toBeDefined()

        const listResp = await client.callTool({ name: 'list_agents', arguments: {} })
        const list = JSON.parse((listResp.content as Array<{ text: string }>)[0].text) as { agents: Array<{ agent_id: string; tmux_pane_id: string | null }> }
        expect(list.agents.find(a => a.agent_id === reg.agent_id)?.tmux_pane_id).toBe('%42')

        // Direct DB cross-check
        const db = openDb(dbPath); applySchema(db)
        const row = db.prepare(`SELECT tmux_pane_id FROM agents WHERE agent_id=?`).get(reg.agent_id) as { tmux_pane_id: string }
        expect(row.tmux_pane_id).toBe('%42')
        db.close()

        await transport.terminateSession()
        await app.close()
      })
    })
    ```
  - [x] **Verify INTEGRATION-RED:** Fails because `register_agent` inputSchema rejects `tmux_pane_id` (unknown field via zod strictness) OR persists nothing for the column.
    - Command: `pnpm exec vitest run tests/register-agent-tmux-pane.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      × tests/register-agent-tmux-pane.test.ts > register_agent tmux_pane_id integration > accepts tmux_pane_id and persists + exposes it
        → expected null to be '%42' // Object.is equality
      AssertionError: expected null to be '%42' // Object.is equality
      - Expected:
      "%42"
      + Received:
      null
       ❯ tests/register-agent-tmux-pane.test.ts:36:78
       Test Files  1 failed (1)
            Tests  1 failed (1)
      Observation: zod inputSchema silently strips the extra `tmux_pane_id` arg, so list_agents shows null for the agent.
      ```
  - [x] **INTEGRATION-GREEN:** Update `src/mcp/register-agent.ts` `RegisterInput` and the plumbing, plus `src/mcp/tools.ts`:
    ```ts
    // register-agent.ts
    export interface RegisterInput {
      agent_id: string
      connection_id: string
      model: string
      role: string
      display_name?: string
      team?: string
      tmux_pane_id?: string
    }
    // register() forwards to repo: this.repo.register({ ...input, tmux_pane_id: input.tmux_pane_id })

    // tools.ts — register_agent registration
    inputSchema: {
      model: z.string(),
      role: z.string(),
      display_name: z.string().optional(),
      team: z.string().optional(),
      tmux_pane_id: z.string().optional()
    }
    // handler passes through args.tmux_pane_id to registerSvc.register({..., tmux_pane_id: args.tmux_pane_id})
    ```
  - [x] **Verify INTEGRATION-GREEN:**
    - Command: `pnpm exec vitest run tests/register-agent-tmux-pane.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/register-agent-tmux-pane.test.ts > register_agent tmux_pane_id integration > accepts tmux_pane_id and persists + exposes it
       Test Files  1 passed (1)
            Tests  1 passed (1)
         Duration  275ms
      Full suite: Test Files  43 passed (43) / Tests  98 passed (98)
      ```
  - [x] **REFACTOR:** Confirm `register_agent` tool handler still ≤30 lines (does not grow hard-to-read).
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/register-agent-tmux-pane.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      Handler still ≤30 lines; no additional changes.  Target test re-run:
       Test Files  1 passed (1)
            Tests  1 passed (1)
      ```
  - [x] **Commit:** `feat(mcp): expose tmux_pane_id in register_agent input schema`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `935d70f`

- [x] 3.2 `list_agents` MCP tool returns `tmux_pane_id` for each agent (covered end-to-end by 3.1's list assertion)
  - kind: integration-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `list_agents returns tmux_pane_id for each agent`
  - **Files:**
    - Edit: `tests/register-agent-tmux-pane.test.ts` (add second scenario with both "with" and "without" agents)
  - [x] **INTEGRATION-RED:** Add test
    ```ts
    it('list_agents returns tmux_pane_id: string for one agent and null for another', async () => {
      const dir = tmp(); cleanups.push(dir)
      const { app, port } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
      const url = new URL(`http://127.0.0.1:${port}/mcp`)
      const makeClient = async () => {
        const t = new StreamableHTTPClientTransport(url)
        const c = new Client({ name: 'test', version: '0.0.0' })
        await c.connect(t)
        return { c, t }
      }
      const A = await makeClient()
      const B = await makeClient()
      const regA = JSON.parse(((await A.c.callTool({ name: 'register_agent', arguments: { model: 'opus-4-7', role: 'frontend', tmux_pane_id: '%42' } })).content as Array<{ text: string }>)[0].text) as { agent_id: string }
      const regB = JSON.parse(((await B.c.callTool({ name: 'register_agent', arguments: { model: 'gpt-5', role: 'reviewer' } })).content as Array<{ text: string }>)[0].text) as { agent_id: string }
      const list = JSON.parse(((await A.c.callTool({ name: 'list_agents', arguments: {} })).content as Array<{ text: string }>)[0].text) as { agents: Array<{ agent_id: string; tmux_pane_id: string | null }> }
      const a = list.agents.find(x => x.agent_id === regA.agent_id)
      const b = list.agents.find(x => x.agent_id === regB.agent_id)
      expect(a?.tmux_pane_id).toBe('%42')
      expect(b?.tmux_pane_id).toBeNull()
      await A.t.terminateSession(); await B.t.terminateSession(); await app.close()
    })
    ```
  - [x] **Verify INTEGRATION-RED:** Same class of failure as 3.1 before GREEN applied
    - Command: `pnpm exec vitest run tests/register-agent-tmux-pane.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      Tasks 2.5 + 3.1 already made this scenario green by construction.  Test passes on first addition:
      ✓ tests/register-agent-tmux-pane.test.ts > register_agent tmux_pane_id integration > list_agents returns tmux_pane_id: string for one agent and null for another
       Test Files  1 passed (1)
            Tests  2 passed (2)
      ```
  - [x] **INTEGRATION-GREEN:** No new production code; task 2.5 already extended `list` to select the column, and task 3.1 plumbed it through MCP
  - [x] **Verify INTEGRATION-GREEN:**
    - Command: `pnpm exec vitest run tests/register-agent-tmux-pane.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/register-agent-tmux-pane.test.ts > register_agent tmux_pane_id integration > list_agents returns tmux_pane_id: string for one agent and null for another
       Test Files  1 passed (1)
            Tests  2 passed (2)
         Duration  299ms
      ```
  - [x] **REFACTOR:** None
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/register-agent-tmux-pane.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      No refactor.  Target tests re-run:
       Test Files  1 passed (1)
            Tests  2 passed (2)
      ```
  - [x] **Commit:** `test(mcp): list_agents returns tmux_pane_id per agent`
    - **Commit SHA (fill during apply):** `6660752`

## 4. Docs: onboarding guide for each code agent

- [x] 4.1 Update `docs/configs/{claude-code,opencode,codex-cli}.md` with tmux pane id onboarding instructions
  - kind: manual-verify
  - **Spec scenario(s):** n/a (documentation-only)
  - **Files:**
    - Edit: `docs/configs/claude-code.md`
    - Edit: `docs/configs/opencode.md`
    - Edit: `docs/configs/codex-cli.md`
    - Edit: `docs/configs/README.md` (single line addition pointing at the tmux step)
  - [x] **IMPLEMENT:** Append to each of the three agent-specific files a short section:
    ```markdown
    ## Reporting your tmux pane id on register (optional)

    If you run this agent inside a tmux pane and want future `poke`-style cross-agent interrupts to target you, include your pane id on first `register_agent`.

    Get the pane id (inside the agent's own pane, via a shell call):

        tmux display-message -p '#{pane_id}'

    This prints something like `%42`. Pass it to `register_agent`:

        register_agent({ model: "...", role: "...", team: "...", tmux_pane_id: "%42" })

    The field is optional. Non-tmux environments can omit it.
    ```
    Also add one line to `docs/configs/README.md` pointing to this step.
  - [x] **MANUAL-VERIFY:** user reviewed wording via AskUserQuestion at driver (main-agent) scope after the subagent's apply phase deferred
    - Resolved via driver-level AskUserQuestion (apply-fixup path, mirrors build-agent-teams-mcp iteration 1 precedent)
    - **Evidence (fill during apply):**
      ```
      Q: Task 4.1 manual-verify: docs/configs 已落地 (commit 8703e36), 接受吗?
      A: 接受 (user option: "接受 (Recommended)")
      Notes: 接受, 不过有一个地方需要提醒一下, 因为项目还没有大规模应用, 不用考虑旧的db迁移的问题.
      Interpretation: wording/placement accepted; user raised an out-of-scope observation that future changes need not plan for legacy-db migration paths given current project maturity (stored as a feedback memory for future design decisions; does not retroactively invalidate Task 1.2 which is already green and committed).
      ```
  - [x] **Commit:** `docs(configs): add tmux_pane_id onboarding section per agent`
    - **Commit SHA (fill during apply):** `8703e36`

## Scenario Coverage Matrix

| Spec scenario | Test file | Task |
|---|---|---|
| `Fresh database creates agents table with nine columns` | `tests/agents-schema.test.ts` | 1.1 |
| `Legacy database auto-migrates by adding tmux_pane_id column` | `tests/agents-legacy-migration.test.ts` | 1.2 |
| `New session registers with tmux_pane_id provided` | `tests/agents-repo.test.ts` + `tests/register-agent-tmux-pane.test.ts` | 2.1, 3.1 |
| `New session registers without tmux_pane_id` | `tests/agents-repo.test.ts` | 2.2 |
| `Same session re-registers with new tmux_pane_id` | `tests/agents-repo.test.ts` | 2.3 |
| `Same session re-registers omitting tmux_pane_id does not clear existing value` | `tests/agents-repo.test.ts` | 2.4 |
| `list_agents returns tmux_pane_id for each agent` | `tests/agents-repo.test.ts` + `tests/register-agent-tmux-pane.test.ts` | 2.5, 3.2 |
| `Missing tmux_pane_id persists as NULL` | `tests/agents-repo.test.ts` | 2.2 (shared) |
| `Non-tmux environment unaffected by new field` | `tests/agents-repo.test.ts` | 2.2 (shared) |
| `Opaque string preserved regardless of format` | `tests/agents-repo.test.ts` | 2.6 |

Total unique spec scenarios: 10.  Total top-level tasks: 10.  Every scenario has at least one task-level test assertion.
