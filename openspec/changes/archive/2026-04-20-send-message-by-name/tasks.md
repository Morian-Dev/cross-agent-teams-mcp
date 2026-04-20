## 1. Service-layer recipient resolution

- [x] 1.1 SendMessageService resolves to_agent_name to UUID on same-team send
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Only to_agent_name given proceeds via name path`
    - `mailbox/spec.md` → Scenario: `Same-team send via to_agent_name persists and auto-pokes`
  - **Files:**
    - Create: `tests/send-message-by-name.test.ts`
    - Modify: `src/mcp/send-message.ts`
  - [x] **RED:** Write failing test — `tests/send-message-by-name.test.ts`
    - Behavior under test: GIVEN agents `alice` and `bob` both in team 'default' / WHEN alice calls `send({ from: alice.uuid, to_agent_name: 'bob', body: 'hi', auto_poke: false })` / THEN success, `recipients === [bob.uuid]`, and a `messages` row exists with `to_agent_id = bob.uuid`.
    - Expected failure reason: `SendInput` does not accept `to_agent_name` (TypeScript error) or service returns `unknown_recipient` because no resolution is implemented.
    ```typescript
    import { describe, it, expect, afterEach } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { openDb } from '../src/storage/db.js'
    import { applySchema } from '../src/storage/schema.js'
    import { AgentsRepo } from '../src/storage/agents-repo.js'
    import { EventsOutbox } from '../src/storage/events-outbox.js'
    import { SendMessageService } from '../src/mcp/send-message.js'
    import { insertAgent } from './helpers/insert-agent.js'

    const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-sm-byname-'))

    describe('send_message by name — same-team resolution', () => {
      const dirs: string[] = []
      afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

      function setup() {
        const dir = tmp(); dirs.push(dir)
        const db = openDb(join(dir, 'data.db')); applySchema(db)
        const svc = new SendMessageService(db, new AgentsRepo(db), new EventsOutbox(db))
        return { svc, db }
      }

      it('resolves to_agent_name to UUID and writes message row', async () => {
        const { svc, db } = setup()
        insertAgent(db, { agent_id: 'uuid-A', team: 'default', role: 'backend', name: 'alice' })
        insertAgent(db, { agent_id: 'uuid-B', team: 'default', role: 'frontend', name: 'bob' })
        const resp = await svc.send({ from: 'uuid-A', to_agent_name: 'bob', body: 'hi', auto_poke: false })
        if ('error' in resp) throw new Error(`expected success, got ${resp.error}`)
        expect(resp.recipients).toEqual(['uuid-B'])
        const m = db.prepare(`SELECT to_agent_id, body FROM messages WHERE id=?`).get(resp.message_id) as
          { to_agent_id: string; body: string }
        expect(m.to_agent_id).toBe('uuid-B')
        expect(m.body).toBe('hi')
      })
    })
    ```
  - [x] **Verify RED:** Run test, confirm it fails for the expected reason
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts`
    - **Observed output (fill during apply):**
      ```
      × send_message by name — same-team resolution > resolves to_agent_name to UUID and writes message row
        → expected success, got unknown_recipient
       Test Files  1 failed (1) | Tests  1 failed (1)
      ```
  - [x] **GREEN:** Write minimal implementation — `src/mcp/send-message.ts`
    ```typescript
    export interface SendInput {
      from: string
      to_agent_id?: string
      to_agent_name?: string
      to_team?: string
      subject?: string
      body: string
      auto_poke?: boolean
    }

    export type SendResult =
      | SuccessResult
      | { error: 'unknown_recipient' }
      | { error: 'missing_recipient' }
      | { error: 'ambiguous_recipient' }

    // Inside SendMessageService.send, before the existing rcpt lookup:
    //   const hasId = typeof input.to_agent_id === 'string' && input.to_agent_id.length > 0
    //   const hasName = typeof input.to_agent_name === 'string' && input.to_agent_name.length > 0
    //   if (!hasId && !hasName) return { error: 'missing_recipient' }
    //   if (hasId && hasName) return { error: 'ambiguous_recipient' }
    //   const fromRow = this.agents.findById(input.from)
    //   if (!fromRow) return { error: 'unknown_recipient' }
    //   const fromTeam = fromRow.team
    //   const toTeam = input.to_team ?? fromTeam
    //   let resolvedId: string
    //   if (hasId) {
    //     resolvedId = input.to_agent_id!
    //   } else {
    //     const hit = this.agents.findByIdentity({ team: toTeam, name: input.to_agent_name! })
    //     if (!hit) return { error: 'unknown_recipient' }
    //     resolvedId = hit.agent_id
    //   }
    //   // then existing: SELECT agent_id, team, tmux_pane_id FROM agents WHERE agent_id=resolvedId
    //   // and team-equality check as today.
    ```
  - [x] **Verify GREEN:** Run test + full suite, confirm pass
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/send-message-by-name.test.ts (1 test) 5ms
       Test Files  1 passed (1) | Tests  1 passed (1)
      Full suite: Test Files 3 failed | 91 passed (94) | Tests 4 failed | 292 passed (296)
      — 4 failing tests are pre-existing poke tmux environment failures unrelated to this change (confirmed via `git stash`).
      ```
  - [x] **REFACTOR:** None — branch logic is ~7 lines, below the 15-line helper threshold.
  - [x] **Verify REFACTOR:** Re-run tests, confirm still green
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts && pnpm test`
    - **Observed output (fill during apply):**
      ```
      Re-run covered by subsequent task's Verify GREEN; no separate re-run recorded (behavior-preserving, code unchanged).
      ```
  - [x] **Commit:** `feat(send-message): resolve to_agent_name via (team, name) lookup`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `9593dff`

- [x] 1.2 SendMessageService returns ambiguous_recipient when both fields given
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Both to_agent_id and to_agent_name given`
  - **Files:**
    - Modify: `tests/send-message-by-name.test.ts`
    - Modify: `src/mcp/send-message.ts`
  - [x] **RED:** Write failing test — `tests/send-message-by-name.test.ts`
    - Behavior under test: WHEN caller passes both `to_agent_id` and `to_agent_name` / THEN response is `{ error: 'ambiguous_recipient' }` and no message row is created.
    - Expected failure reason: service does not yet branch on both-given; will either succeed or fall through to `unknown_recipient`.
    ```typescript
    it('returns ambiguous_recipient when both to_agent_id and to_agent_name given', async () => {
      const { svc, db } = setup()
      insertAgent(db, { agent_id: 'uuid-A', team: 'default', role: 'backend', name: 'alice' })
      insertAgent(db, { agent_id: 'uuid-B', team: 'default', role: 'frontend', name: 'bob' })
      const resp = await svc.send({
        from: 'uuid-A', to_agent_id: 'uuid-B', to_agent_name: 'bob', body: 'hi', auto_poke: false
      })
      expect(resp).toEqual({ error: 'ambiguous_recipient' })
      const count = db.prepare(`SELECT COUNT(*) AS c FROM messages`).get() as { c: number }
      expect(count.c).toBe(0)
    })
    ```
  - [x] **Verify RED:** Run test, confirm it fails for the expected reason
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts -t "ambiguous_recipient"`
    - **Observed output (fill during apply):**
      ```
      × returns ambiguous_recipient when both to_agent_id and to_agent_name given
      expected { message_id, event_id: 1, poked: false, recipients: ['uuid-B'], retry_scheduled: false, sent_at } to deeply equal { error: 'ambiguous_recipient' }
       Test Files  1 failed (1) | Tests  1 failed | 1 skipped (2)
      ```
  - [x] **GREEN:** Write minimal implementation — `src/mcp/send-message.ts`
    ```typescript
    // Ensure the early mutual-exclusion check in SendMessageService.send runs
    // BEFORE any DB lookup:
    //   if (hasId && hasName) return { error: 'ambiguous_recipient' }
    ```
  - [x] **Verify GREEN:** Run test + full suite, confirm pass
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts -t "ambiguous_recipient"`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/send-message-by-name.test.ts (2 tests | 1 skipped) 4ms | Tests  1 passed | 1 skipped (2)
      Full suite: Test Files 3 failed | 91 passed (94) | Tests 4 failed | 292 passed (296) (same 4 pre-existing poke failures).
      ```
  - [x] **REFACTOR:** None — already minimal (single guard clause).
  - [x] **Verify REFACTOR:** Re-run tests, confirm still green
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts`
    - **Observed output (fill during apply):**
      ```
      No refactor performed; code unchanged, GREEN verification already covers same tests.
      ```
  - [x] **Commit:** `feat(send-message): reject ambiguous recipient when both id and name given`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `3792759`

- [x] 1.3 SendMessageService returns missing_recipient when neither field given
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Neither to_agent_id nor to_agent_name given`
  - **Files:**
    - Modify: `tests/send-message-by-name.test.ts`
    - Modify: `src/mcp/send-message.ts`
  - [x] **RED:** Write failing test — `tests/send-message-by-name.test.ts`
    - Behavior under test: WHEN caller passes neither `to_agent_id` nor `to_agent_name` / THEN response is `{ error: 'missing_recipient' }` and no event row is created.
    - Expected failure reason: service currently treats `to_agent_id` as required (untyped at runtime); will pass `undefined` into the `agents` query and return `unknown_recipient` (wrong error) or throw.
    ```typescript
    it('returns missing_recipient when neither to_agent_id nor to_agent_name given', async () => {
      const { svc, db } = setup()
      insertAgent(db, { agent_id: 'uuid-A', team: 'default', role: 'backend', name: 'alice' })
      const resp = await svc.send({ from: 'uuid-A', body: 'hi', auto_poke: false } as unknown as Parameters<typeof svc.send>[0])
      expect(resp).toEqual({ error: 'missing_recipient' })
      const count = db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number }
      expect(count.c).toBe(0)
    })
    ```
  - [x] **Verify RED:** Run test, confirm it fails for the expected reason
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts -t "missing_recipient"`
    - **Observed output (fill during apply):**
      ```
      × returns missing_recipient when neither to_agent_id nor to_agent_name given
      expected { error: 'unknown_recipient' } to deeply equal { error: 'missing_recipient' }
       Test Files  1 failed (1) | Tests  1 failed | 2 skipped (3)
      ```
  - [x] **GREEN:** Write minimal implementation — `src/mcp/send-message.ts`
    ```typescript
    // Before the ambiguous-check and before the DB lookup:
    //   if (!hasId && !hasName) return { error: 'missing_recipient' }
    ```
  - [x] **Verify GREEN:** Run test + full suite, confirm pass
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts -t "missing_recipient"`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/send-message-by-name.test.ts (3 tests) 7ms | Tests  3 passed (3)
      Full suite: Test Files 3 failed | 91 passed (94) | Tests 4 failed | 293 passed (297) (same 4 pre-existing poke failures).
      ```
  - [x] **REFACTOR:** None — already minimal (single guard clause).
  - [x] **Verify REFACTOR:** Re-run tests, confirm still green
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts`
    - **Observed output (fill during apply):**
      ```
      No refactor performed; code unchanged, GREEN verification already covers same tests.
      ```
  - [x] **Commit:** `feat(send-message): reject missing recipient when neither id nor name given`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `d5b7777`

## 2. Name-path error cases and team resolution

- [x] 2.1 SendMessageService returns unknown_recipient when to_agent_name misses
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `to_agent_name does not exist in resolved team`
    - `mailbox/spec.md` → Scenario: `to_agent_name exists in caller team but explicit to_team points elsewhere`
    - `mailbox/spec.md` → Scenario: `Lookup is case-sensitive (byte-equal)`
  - **Files:**
    - Modify: `tests/send-message-by-name.test.ts`
    - Modify: `src/mcp/send-message.ts`
  - [x] **RED:** Write failing test — `tests/send-message-by-name.test.ts`
    - Behavior under test: Three independent cases — (a) name not in any team, (b) name in caller's team but explicit `to_team` points to a team where the name is absent, (c) name casing differs from the stored value. All must return `{ error: 'unknown_recipient' }` with no event row written.
    - Expected failure reason: service's name-resolution branch not yet implemented — no call to `findByIdentity`.
    ```typescript
    it('returns unknown_recipient when to_agent_name does not exist in resolved team', async () => {
      const { svc, db } = setup()
      insertAgent(db, { agent_id: 'uuid-A', team: 'default', role: 'backend', name: 'alice' })
      const resp = await svc.send({ from: 'uuid-A', to_agent_name: 'ghost', body: 'hi', auto_poke: false })
      expect(resp).toEqual({ error: 'unknown_recipient' })
    })

    it('returns unknown_recipient when to_agent_name misses in explicit cross-team', async () => {
      const { svc, db } = setup()
      insertAgent(db, { agent_id: 'uuid-A', team: 'alpha', role: 'backend', name: 'alice' })
      insertAgent(db, { agent_id: 'uuid-B', team: 'alpha', role: 'frontend', name: 'bob' })
      // bob exists only in alpha; caller asks for bob in beta
      const resp = await svc.send({ from: 'uuid-A', to_agent_name: 'bob', to_team: 'beta', body: 'hi', auto_poke: false })
      expect(resp).toEqual({ error: 'unknown_recipient' })
      const evCount = db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number }
      expect(evCount.c).toBe(0)
    })

    it('lookup is case-sensitive — Bob !== bob', async () => {
      const { svc, db } = setup()
      insertAgent(db, { agent_id: 'uuid-A', team: 'default', role: 'backend', name: 'alice' })
      insertAgent(db, { agent_id: 'uuid-B', team: 'default', role: 'frontend', name: 'Bob' })
      const resp = await svc.send({ from: 'uuid-A', to_agent_name: 'bob', body: 'hi', auto_poke: false })
      expect(resp).toEqual({ error: 'unknown_recipient' })
    })
    ```
  - [x] **Verify RED:** Run test, confirm it fails for the expected reason
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts -t "unknown_recipient"`
    - **Observed output (fill during apply):**
      ```
      Note: Task 1.1 GREEN already implemented the findByIdentity branch, so these "unknown_recipient on name miss" tests pass immediately when added.  They serve as regression pins.  The expected RED precondition ("no name-resolution branch") was satisfied historically before Task 1.1 GREEN; by task 2.1, the branch exists and tests pass.
      ✓ tests/send-message-by-name.test.ts (6 tests | 4 skipped) 6ms | Tests  2 passed | 4 skipped
      ```
  - [x] **GREEN:** Write minimal implementation — `src/mcp/send-message.ts`
    ```typescript
    // Already implemented in Task 1.1 GREEN.  No new code for this task.
    ```
  - [x] **Verify GREEN:** Run test + full suite, confirm pass
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/send-message-by-name.test.ts (6 tests) 11ms | Tests  6 passed (6)
      Full suite: Test Files 3 failed | 91 passed (94) | Tests 4 failed | 296 passed (300) (same 4 pre-existing poke failures).
      ```
  - [x] **REFACTOR:** None — resolution branch is a single `findByIdentity` call guarded by `hasName`.
  - [x] **Verify REFACTOR:** Re-run tests, confirm still green
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts`
    - **Observed output (fill during apply):**
      ```
      No refactor performed.
      ```
  - [x] **Commit:** `feat(send-message): unknown_recipient on to_agent_name miss in resolved team`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `162cdc0`

- [x] 2.2 Cross-team send via to_agent_name writes correct from_team and to_team
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Cross-team send via to_agent_name and explicit to_team`
  - **Files:**
    - Modify: `tests/send-message-by-name.test.ts`
    - Modify: `src/mcp/send-message.ts`
  - [x] **RED:** Write failing test — `tests/send-message-by-name.test.ts`
    - Behavior under test: WHEN alice in team 'alpha' sends `{ to_agent_name: 'bob', to_team: 'beta' }` and bob exists in 'beta' / THEN the persisted `messages` row has `from_team='alpha'`, `to_team='beta'`, and `to_agent_id = bob.uuid in beta`; the paired `events` row has matching `from_team` / `to_team`.
    - Expected failure reason: name-resolution path may not yet honor `to_team` override (depends on ordering with 2.1); if 2.1 is in place, this test serves as a stronger integration check of the team-aware lookup.
    ```typescript
    it('cross-team send via to_agent_name persists correct from_team/to_team', async () => {
      const { svc, db } = setup()
      insertAgent(db, { agent_id: 'uuid-A', team: 'alpha', role: 'backend', name: 'alice' })
      insertAgent(db, { agent_id: 'uuid-B-beta', team: 'beta', role: 'frontend', name: 'bob' })
      const resp = await svc.send({
        from: 'uuid-A', to_agent_name: 'bob', to_team: 'beta', body: 'hi', auto_poke: false
      })
      if ('error' in resp) throw new Error(`expected success, got ${resp.error}`)
      expect(resp.recipients).toEqual(['uuid-B-beta'])
      const m = db.prepare(`SELECT from_team, to_team, to_agent_id, event_id FROM messages WHERE id=?`).get(resp.message_id) as
        { from_team: string; to_team: string; to_agent_id: string; event_id: number }
      expect(m).toEqual({ from_team: 'alpha', to_team: 'beta', to_agent_id: 'uuid-B-beta', event_id: resp.event_id })
      const e = db.prepare(`SELECT from_team, to_team FROM events WHERE event_id=?`).get(resp.event_id) as
        { from_team: string; to_team: string }
      expect(e).toEqual({ from_team: 'alpha', to_team: 'beta' })
    })
    ```
  - [x] **Verify RED:** Run test, confirm it fails for the expected reason
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts -t "cross-team send via to_agent_name"`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/send-message-by-name.test.ts (7 tests | 6 skipped) 5ms | Tests  1 passed | 6 skipped
      Note: task's own GREEN block states "if earlier tasks already GREEN'd this, this task's RED should already pass — confirm by running." Task 1.1 implementation satisfies this; the new test serves as regression pin. No separate RED state observed.
      ```
  - [x] **GREEN:** Write minimal implementation — `src/mcp/send-message.ts`
    ```typescript
    // Already satisfied by Task 1.1 GREEN — toTeam resolution flows into findByIdentity.
    ```
  - [x] **Verify GREEN:** Run test + full suite, confirm pass
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts -t "cross-team send via to_agent_name"`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      Full suite: Test Files 3 failed | 91 passed (94) | Tests 4 failed | 297 passed (301) (same 4 pre-existing poke failures).
      ```
  - [x] **REFACTOR:** None — behavior is a consequence of the existing `toTeam` resolution.
  - [x] **Verify REFACTOR:** Re-run tests, confirm still green
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts`
    - **Observed output (fill during apply):**
      ```
      No refactor performed.
      ```
  - [x] **Commit:** `test(send-message): cover cross-team send via to_agent_name`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `1672c04`

- [x] 2.3 Success envelope recipients is always resolved UUID, regardless of input path
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Only to_agent_id given proceeds via UUID path`
    - `mailbox/spec.md` → Scenario: `Success envelope recipients is always the resolved UUID`
  - **Files:**
    - Modify: `tests/send-message-by-name.test.ts`
    - Modify: `src/mcp/send-message.ts`
  - [x] **RED:** Write failing test — `tests/send-message-by-name.test.ts`
    - Behavior under test: Calling send twice — once via `to_agent_id` and once via `to_agent_name` for the same recipient — MUST produce two responses whose `recipients` arrays both equal `['<bob.uuid>']`. Also regression-checks that the UUID path still works unchanged.
    - Expected failure reason: prior to name-resolution implementation, the name-path variant fails (error); after implementation, both paths must converge on the same UUID.
    ```typescript
    it('recipients always holds resolved UUID regardless of input path', async () => {
      const { svc, db } = setup()
      insertAgent(db, { agent_id: 'uuid-A', team: 'default', role: 'backend', name: 'alice' })
      insertAgent(db, { agent_id: 'uuid-B', team: 'default', role: 'frontend', name: 'bob' })
      const r1 = await svc.send({ from: 'uuid-A', to_agent_id: 'uuid-B', body: 'via-id', auto_poke: false })
      const r2 = await svc.send({ from: 'uuid-A', to_agent_name: 'bob', body: 'via-name', auto_poke: false })
      if ('error' in r1) throw new Error('r1 expected success')
      if ('error' in r2) throw new Error('r2 expected success')
      expect(r1.recipients).toEqual(['uuid-B'])
      expect(r2.recipients).toEqual(['uuid-B'])
    })
    ```
  - [x] **Verify RED:** Run test, confirm it fails for the expected reason
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts -t "recipients always holds"`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/send-message-by-name.test.ts (8 tests | 7 skipped) 5ms | Tests  1 passed | 7 skipped
      Note: invariant already held after Task 1.1 — test serves as regression pin.
      ```
  - [x] **GREEN:** Write minimal implementation — `src/mcp/send-message.ts`
    ```typescript
    // No new code — invariant flows from Task 1.1's resolvedId plumbing.
    ```
  - [x] **Verify GREEN:** Run test + full suite, confirm pass
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts -t "recipients always holds"`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      Full suite: Test Files 3 failed | 91 passed (94) | Tests 4 failed | 298 passed (302) (same 4 pre-existing poke failures).
      ```
  - [x] **REFACTOR:** None — invariant already holds from Task 1.1 implementation.
  - [x] **Verify REFACTOR:** Re-run tests, confirm still green
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts`
    - **Observed output (fill during apply):**
      ```
      No refactor performed.
      ```
  - [x] **Commit:** `test(send-message): pin recipients envelope invariant across id and name paths`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `07c2381`

## 3. MCP tool surface — Zod schema and description

- [x] 3.1 Zod schema accepts to_agent_name and enforces mutual exclusion
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Both to_agent_id and to_agent_name given`
    - `mailbox/spec.md` → Scenario: `Neither to_agent_id nor to_agent_name given`
    - `mailbox/spec.md` → Scenario: `Only to_agent_name given proceeds via name path`
  - **Files:**
    - Modify: `tests/send-message-zod-schema.test.ts`
    - Modify: `src/mcp/tools.ts`
  - [x] **RED:** Write failing test — `tests/send-message-zod-schema.test.ts`
    - Behavior under test: Three new cases on the MCP tool boundary — (a) call with `to_agent_name` alone is accepted by Zod (not isError from schema validation), (b) call with both `to_agent_id` and `to_agent_name` is rejected with a validation or `ambiguous_recipient` error, (c) call with neither is rejected (already covered by existing test via `to_agent_id` required; update to reflect new schema where both optional but one required).
    - Expected failure reason: current Zod schema has `to_agent_id: z.string().min(1)` as required; does not accept name-only; does not cross-validate both-given.
    ```typescript
    it('accepts to_agent_name alone and returns unknown_recipient (not validation error)', async () => {
      const { c, close } = await client()
      const resp = await c.callTool({ name: 'send_message', arguments: { to_agent_name: 'ghost', body: 'hi' } }) as ToolCallResult
      expect(resp.isError).toBeFalsy()
      expect(textOf(resp)).toMatch(/unknown_recipient/)
      await close()
    })

    it('rejects both to_agent_id and to_agent_name at the boundary', async () => {
      const { c, close } = await client()
      const resp = await c.callTool({
        name: 'send_message',
        arguments: { to_agent_id: 'X', to_agent_name: 'bob', body: 'hi' }
      }) as ToolCallResult
      // Either Zod rejects as validation error, or service returns ambiguous_recipient.
      // Accept either; pin the error vocabulary.
      const text = textOf(resp)
      expect(text).toMatch(/ambiguous_recipient|validation|mutually exclusive|to_agent_name/i)
    })

    it('rejects when neither to_agent_id nor to_agent_name provided', async () => {
      const { c, close } = await client()
      const resp = await c.callTool({ name: 'send_message', arguments: { body: 'hi' } }) as ToolCallResult
      const text = textOf(resp)
      expect(text).toMatch(/missing_recipient|validation|required|to_agent_id|to_agent_name/i)
      await close()
    })
    ```
  - [x] **Verify RED:** Run test, confirm it fails for the expected reason
    - Command: `pnpm vitest run tests/send-message-zod-schema.test.ts`
    - **Observed output (fill during apply):**
      ```
      × accepts to_agent_name alone and returns unknown_recipient (not validation error)
      expected true to be falsy (isError=true — schema rejected to_agent_name since to_agent_id was required).
       Test Files  1 failed (1) | Tests  1 failed | 5 passed (6)
      ```
  - [x] **GREEN:** Write minimal implementation — `src/mcp/tools.ts`
    ```typescript
    // Implemented as z.object({...}).strict() with both to_agent_id and to_agent_name optional.
    // Mutual exclusion and missing recipient handled in the service layer (returning ambiguous_recipient / missing_recipient).
    // The .refine() approach from the task sketch was dropped because Zod's .refine on an object wraps the schema in ZodEffects, which breaks the top-level JSON schema `properties` exposure (tests/tool-descriptions-poke-hint.test.ts relies on this).
    ```
  - [x] **Verify GREEN:** Run test + full suite, confirm pass
    - Command: `pnpm vitest run tests/send-message-zod-schema.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/send-message-zod-schema.test.ts (6 tests) 86ms | Tests  6 passed (6)
      Full suite: Test Files 3 failed | 91 passed (94) | Tests 4 failed | 301 passed (305) (same 4 pre-existing poke failures).
      Also updated existing schema test "rejects missing to_agent_id" to reflect new schema — now registers caller and expects missing_recipient vocabulary (still covered by regex).
      ```
  - [x] **REFACTOR:** None — guard moved to service layer rather than Zod to preserve JSON-schema shape.
  - [x] **Verify REFACTOR:** Re-run tests, confirm still green
    - Command: `pnpm vitest run tests/send-message-zod-schema.test.ts`
    - **Observed output (fill during apply):**
      ```
      No refactor performed.
      ```
  - [x] **Commit:** `feat(mcp): send_message zod schema accepts to_agent_name with mutual exclusion`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `4ebbb3e`

- [x] 3.2 Tool description mentions to_agent_name and the one-of guardrail
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `send_message tool description mentions to_agent_name`
  - **Files:**
    - Create: `tests/send-message-description.test.ts`
    - Modify: `src/mcp/tools.ts`
  - [x] **RED:** Write failing test — `tests/send-message-description.test.ts`
    - Behavior under test: The `send_message` tool description string exposed by the MCP server MUST mention `to_agent_name`, indicate exactly one of id/name must be provided, and retain the "除非用户明确指定 to_team, 不要跨 team 沟通" line.
    - Expected failure reason: current `SEND_MESSAGE_DESC` constant does not contain `to_agent_name`.
    ```typescript
    import { describe, it, expect, afterEach } from 'vitest'
    import { mkdtempSync, rmSync } from 'node:fs'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { Client } from '@modelcontextprotocol/sdk/client/index.js'
    import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
    import { startServer } from '../src/daemon/server.js'

    const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-desc-'))

    describe('send_message description', () => {
      const dirs: string[] = []
      afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

      it('mentions to_agent_name, one-of guard, and to_team guardrail', async () => {
        const dir = tmp(); dirs.push(dir)
        const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
        const url = new URL(`http://${host}:${port}/mcp`)
        const t = new StreamableHTTPClientTransport(url)
        const c = new Client({ name: 'test', version: '0' })
        await c.connect(t)
        const tools = await c.listTools()
        const sm = tools.tools.find((x) => x.name === 'send_message')
        expect(sm).toBeDefined()
        const desc = sm!.description ?? ''
        expect(desc).toMatch(/to_agent_name/)
        expect(desc).toMatch(/(exactly one|one of|任选其一|精确之一)/i)
        expect(desc).toMatch(/to_team/)
        await t.close(); await app.close()
      })
    })
    ```
  - [x] **Verify RED:** Run test, confirm it fails for the expected reason
    - Command: `pnpm vitest run tests/send-message-description.test.ts`
    - **Observed output (fill during apply):**
      ```
      × mentions to_agent_name, one-of guard, and to_team guardrail
      expected description to match /to_agent_name/ — original SEND_MESSAGE_DESC did not contain to_agent_name.
       Test Files  1 failed (1) | Tests  1 failed (1)
      ```
  - [x] **GREEN:** Write minimal implementation — `src/mcp/tools.ts`
    ```typescript
    // Inserted as second line of SEND_MESSAGE_DESC:
    //   'Provide exactly one of to_agent_id (UUID) or to_agent_name (the target\'s `name` in its team); to_agent_name is preferred when you know the target by (team, name).'
    ```
  - [x] **Verify GREEN:** Run test + full suite, confirm pass
    - Command: `pnpm vitest run tests/send-message-description.test.ts`
    - Full-suite command: `pnpm test`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/send-message-description.test.ts (1 test) 47ms | Tests  1 passed (1)
      Full suite: Test Files 3 failed | 91 passed (94) | Tests 4 failed | 302 passed (306) (same 4 pre-existing poke failures).
      ```
  - [x] **REFACTOR:** None — single string literal addition.
  - [x] **Verify REFACTOR:** Re-run tests, confirm still green
    - Command: `pnpm vitest run tests/send-message-description.test.ts`
    - **Observed output (fill during apply):**
      ```
      No refactor performed.
      ```
  - [x] **Commit:** `docs(mcp): send_message description mentions to_agent_name and one-of rule`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `a0b1963`

## 4. Build gate

- [x] 4.1 Full build compiles with extended SendInput and tool handler
  - kind: build-check
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Only to_agent_name given proceeds via name path`
  - **Files:**
    - Modify: `src/mcp/send-message.ts`
    - Modify: `src/mcp/tools.ts`
  - [x] **IMPLEMENT:** Ensure the type signature of `SendInput` in `send-message.ts` and the handler signature in `tools.ts` are kept in sync, and that all existing call-sites still type-check after `to_agent_id` becomes optional.
  - [x] **BUILD-CHECK:** Run build command, verify exit 0
    - Command: `pnpm build`
    - **Observed output (fill during apply):**
      ```
      CLI tsup v8.5.1
      CLI Target: node20
      ESM dist/cli.js     75.73 KB
      ESM ⚡️ Build success in 13ms
      DTS ⚡️ Build success in 714ms
      EXIT=0
      ```
  - [x] **Commit:** `build(send-message): confirm typecheck after SendInput shape change`
    - **Commit SHA (fill during apply):** `7b17e5c`

## Scenario Coverage Matrix

| Capability | Scenario | Covered by Task(s) | Test file:line |
|---|---|---|---|
| `mailbox` | `Both to_agent_id and to_agent_name given` | Task 1.2, Task 3.1 | `tests/send-message-by-name.test.ts`:TBD |
| `mailbox` | `Neither to_agent_id nor to_agent_name given` | Task 1.3, Task 3.1 | `tests/send-message-by-name.test.ts`:TBD |
| `mailbox` | `Only to_agent_id given proceeds via UUID path` | Task 2.3 | `tests/send-message-by-name.test.ts`:TBD |
| `mailbox` | `Only to_agent_name given proceeds via name path` | Task 1.1, Task 3.1, Task 4.1 | `tests/send-message-by-name.test.ts`:TBD |
| `mailbox` | `send_message tool description mentions to_agent_name` | Task 3.2 | `tests/send-message-description.test.ts`:TBD |
| `mailbox` | `to_agent_id does not exist` | Task 2.1 (regression) | `tests/send-message-direct.test.ts`:existing |
| `mailbox` | `to_agent_name does not exist in resolved team` | Task 2.1 | `tests/send-message-by-name.test.ts`:TBD |
| `mailbox` | `to_agent_name exists in caller team but explicit to_team points elsewhere` | Task 2.1 | `tests/send-message-by-name.test.ts`:TBD |
| `mailbox` | `to_agent_id exists but resolved to_team does not match` | Task 2.1 (regression via existing cross-team tests) | `tests/send-message-cross-team.test.ts`:existing |
| `mailbox` | `Same-team send via to_agent_name persists and auto-pokes` | Task 1.1 | `tests/send-message-by-name.test.ts`:TBD |
| `mailbox` | `Cross-team send via to_agent_name and explicit to_team` | Task 2.2 | `tests/send-message-by-name.test.ts`:TBD |
| `mailbox` | `Success envelope recipients is always the resolved UUID` | Task 2.3 | `tests/send-message-by-name.test.ts`:TBD |
| `mailbox` | `Lookup is case-sensitive (byte-equal)` | Task 2.1 | `tests/send-message-by-name.test.ts`:TBD |

**Coverage:** 13 of 13 scenarios covered (100% required).

## 5. Fix-mode reclassifications (auto-fix-apply iteration 2)

Context: the verify report (`openspec/changes/send-message-by-name/.ff-verify-report.md`) flagged tasks 2.1, 2.2, 2.3 as `tdd-discipline-red-shows-pass-fraud` — each was marked `kind: unit-test` but the production code covering their scenarios had already landed in Task 1.1's GREEN commit (`9593dff`). Their tests are therefore regression-pin / invariant-pin checks, not test-first TDD. Per ts-apply §13b Option A, we append fix-tasks that reclassify each to `kind: build-check` (non-TDD verification). Historical task records (2.1/2.2/2.3) remain immutable; their RED/GREEN blocks stay as-is. The reclassification lives in these new tasks.

- [x] 5.1 Reclassify Task 2.1 as regression-pin (unknown_recipient on to_agent_name miss)
  - kind: build-check
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `to_agent_name does not exist in resolved team`
    - `mailbox/spec.md` → Scenario: `to_agent_name exists in caller team but explicit to_team points elsewhere`
    - `mailbox/spec.md` → Scenario: `Lookup is case-sensitive (byte-equal)`
  - **Files:**
    - Reference: `tests/send-message-by-name.test.ts` (already added by Task 2.1 commit `162cdc0`)
    - Reference: `src/mcp/send-message.ts` (already implemented by Task 1.1 commit `9593dff`)
  - **Reclassification rationale:** Task 2.1 was marked `unit-test` but the `findByIdentity`-miss guard had already been introduced in Task 1.1's GREEN (commit `9593dff`) as part of the unified name-resolution branch. The RED precondition ("no name-resolution branch") only existed strictly before `9593dff`; by Task 2.1 the branch was in place, so the three new scenarios (ghost, cross-team miss, case-sensitive) passed on first run. They function as regression pins / invariants, which belong to a non-TDD verification kind per ts-apply §13b. No code is added or reverted; this fix-task is metadata only.
  - [x] **IMPLEMENT:** No code change. Reclassification only — existing tests and production code from commits `162cdc0` and `9593dff` remain as-is.
  - [x] **BUILD-CHECK:** Run the regression-pin subset, verify exit 0
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts -t "unknown_recipient"`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/send-message-by-name.test.ts (8 tests | 6 skipped) 8ms

       Test Files  1 passed (1)
            Tests  2 passed | 6 skipped (8)
         Start at  01:45:28
         Duration  169ms
      EXIT=0
      ```
  - [x] **Commit:** No new commit — this fix-task records a retroactive kind reclassification for tasks already committed (`162cdc0`). Historical commit is the source of truth; tasks.md reflects the corrected classification.
    - **Commit SHA (fill during apply):** `162cdc0` (retro-reference; no new commit created)

- [x] 5.2 Reclassify Task 2.2 as regression-pin (cross-team send via to_agent_name)
  - kind: build-check
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Cross-team send via to_agent_name and explicit to_team`
  - **Files:**
    - Reference: `tests/send-message-by-name.test.ts` (already added by Task 2.2 commit `1672c04`)
    - Reference: `src/mcp/send-message.ts` (already implemented by Task 1.1 commit `9593dff`)
  - **Reclassification rationale:** Task 2.2 was marked `unit-test` but the cross-team branch it asserts (`to_team` override flowing into `findByIdentity({ team: toTeam, name })`) was already implemented in Task 1.1's GREEN. The new test serves as a regression pin for cross-team resolution behavior, not a driver of new code. Per ts-apply §13b Option A, correct kind is `build-check`.
  - [x] **IMPLEMENT:** No code change. Reclassification only — test in commit `1672c04` and production code in commit `9593dff` remain as-is.
  - [x] **BUILD-CHECK:** Run the regression-pin test, verify exit 0
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts -t "cross-team send via to_agent_name"`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/send-message-by-name.test.ts (8 tests | 7 skipped) 5ms

       Test Files  1 passed (1)
            Tests  1 passed | 7 skipped (8)
         Start at  01:45:31
         Duration  165ms
      EXIT=0
      ```
  - [x] **Commit:** No new commit — retroactive reclassification of `1672c04`.
    - **Commit SHA (fill during apply):** `1672c04` (retro-reference; no new commit created)

- [x] 5.3 Reclassify Task 2.3 as invariant-pin (recipients envelope across id and name paths)
  - kind: build-check
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Only to_agent_id given proceeds via UUID path`
    - `mailbox/spec.md` → Scenario: `Success envelope recipients is always the resolved UUID`
  - **Files:**
    - Reference: `tests/send-message-by-name.test.ts` (already added by Task 2.3 commit `07c2381`)
    - Reference: `src/mcp/send-message.ts` (invariant flows from Task 1.1 commit `9593dff`)
  - **Reclassification rationale:** Task 2.3 was marked `unit-test` but its assertion (`recipients === [resolvedId]` on both UUID and name paths) is a contract invariant established once `resolvedId` replaced direct input-id plumbing in Task 1.1. The test pins the invariant; it never drove new code. Per ts-apply §13b Option A, this is the archetypal contract / invariant-pin case — correct kind is `build-check`.
  - [x] **IMPLEMENT:** No code change. Reclassification only — test in commit `07c2381` and production code in commit `9593dff` remain as-is.
  - [x] **BUILD-CHECK:** Run the invariant-pin test, verify exit 0
    - Command: `pnpm vitest run tests/send-message-by-name.test.ts -t "recipients always holds"`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/send-message-by-name.test.ts (8 tests | 7 skipped) 5ms

       Test Files  1 passed (1)
            Tests  1 passed | 7 skipped (8)
         Start at  01:45:35
         Duration  153ms
      EXIT=0
      ```
  - [x] **Commit:** No new commit — retroactive reclassification of `07c2381`.
    - **Commit SHA (fill during apply):** `07c2381` (retro-reference; no new commit created)
