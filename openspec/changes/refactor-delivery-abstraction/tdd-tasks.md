# TDD Tasks: refactor-delivery-abstraction

> Sidecar to tasks.md. The OpenSpec CLI does NOT read this file.
> Consistency with tasks.md is enforced by ts-tdd-verify.
> Each `## TDD for <N> <title>` section mirrors a first-level checkbox in tasks.md.

## TDD for 1.1 Define `DeliverySpec` discriminated union in a new module (e.g. `src/lib/delivery-spec.ts`) with kinds `'none'`, `'claude-channel'`, `'codex-appserver'`
- kind: unit-test
- **Spec scenario(s):**
  - `agent-delivery/spec.md` → Scenario: `kind 'none' has no payload`
  - `agent-delivery/spec.md` → Scenario: `kind 'claude-channel' carries channel_session_id`
  - `agent-delivery/spec.md` → Scenario: `kind 'codex-appserver' carries thread_id and ws_url`
- **Files:**
  - Create: `tests/delivery-spec.test.ts`
  - Create: `src/lib/delivery-spec.ts`
- [x] **RED:** Write failing type-shape tests — `tests/delivery-spec.test.ts`
- [x] **Verify RED:** run `pnpm test tests/delivery-spec.test.ts`, confirm failure
  - **Observed output:**
    ```
     RUN  v2.1.9 /Users/jtianling/workspace/cross-agent-teams-mcp-workspace/cross-agent-teams-mcp

     ❯ tests/delivery-spec.test.ts (0 test)

    ⎯⎯⎯⎯⎯⎯ Failed Suites 1 ⎯⎯⎯⎯⎯⎯⎯

     FAIL  tests/delivery-spec.test.ts [ tests/delivery-spec.test.ts ]
    Error: Failed to load url ../src/lib/delivery-spec.js (resolved id: ../src/lib/delivery-spec.js) in /Users/jtianling/workspace/cross-agent-teams-mcp-workspace/cross-agent-teams-mcp/tests/delivery-spec.test.ts. Does the file exist?
     ❯ loadAndTransform node_modules/.pnpm/vite@5.4.21_@types+node@22.19.17/node_modules/vite/dist/node/chunks/dep-BK3b2jBa.js:51969:17

    ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

     Test Files  1 failed (1)
          Tests  no tests
     ELIFECYCLE  Test failed. See above for more details.
    ```
- [x] **GREEN:** Define the `DeliverySpec` discriminated union with the three kinds and their kind-specific fields — `src/lib/delivery-spec.ts`
- [x] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    # targeted test
     ✓ tests/delivery-spec.test.ts (5 tests) 1ms
     Test Files  1 passed (1)
          Tests  5 passed (5)

    # full suite
     Test Files  102 passed (102)
          Tests  320 passed (320)
       Duration  15.69s
    ```
- [x] **REFACTOR:** None — already minimal
- [x] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
     ✓ tests/delivery-spec.test.ts (5 tests) 1ms
     Test Files  1 passed (1)
          Tests  5 passed (5)
       Duration  124ms
    ```
- [x] **Commit:** `feat(lib): add DeliverySpec discriminated union (Task 1.1)`
  - **Commit SHA:** `c64ed68`

## TDD for 1.2 Implement `parseDeliveryRow(row: { delivery_kind, delivery_payload }): DeliverySpec` with `corrupt_delivery_payload` error on parse failure
- kind: unit-test
- **Spec scenario(s):**
  - `agent-delivery/spec.md` → Scenario: `Reading back a kind 'claude-channel' row reconstructs the spec`
  - `agent-delivery/spec.md` → Scenario: `Reading a non-'none' row with unparseable payload fails fast`
- **Files:**
  - Modify: `tests/delivery-spec.test.ts`
  - Modify: `src/lib/delivery-spec.ts`
- [x] **RED:** Add failing parse tests: kind 'none' row → `{kind: 'none'}`; kind 'claude-channel' JSON row → full spec; unparseable JSON → throws `corrupt_delivery_payload`
- [x] **Verify RED:** run `pnpm test tests/delivery-spec.test.ts`, confirm failure
  - **Observed output:**
    ```
     RUN  v2.1.9 /Users/jtianling/workspace/cross-agent-teams-mcp-workspace/cross-agent-teams-mcp

     ❯ tests/delivery-spec.test.ts (8 tests | 3 failed) 5ms
       × parseDeliveryRow (Task 1.2) > kind none row with null payload returns {kind: none} 2ms
         → parseDeliveryRow is not a function
       × parseDeliveryRow (Task 1.2) > kind claude-channel row reconstructs channel_session_id from JSON payload 0ms
         → parseDeliveryRow is not a function
       × parseDeliveryRow (Task 1.2) > throws corrupt_delivery_payload when non-none payload fails to parse as JSON 2ms
         → expected [Function] to throw error including 'corrupt_delivery_payload' but got 'parseDeliveryRo…'

     Test Files  1 failed (1)
          Tests  3 failed | 5 passed (8)
    ```
- [x] **GREEN:** Implement `parseDeliveryRow` per `agent-delivery/spec.md` reconstruction rules
- [x] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    # scoped
     RUN  v2.1.9 /Users/jtianling/workspace/cross-agent-teams-mcp-workspace/cross-agent-teams-mcp
     ✓ tests/delivery-spec.test.ts (8 tests) 2ms
     Test Files  1 passed (1)
          Tests  8 passed (8)
       Duration  122ms

    # full suite
     Test Files  102 passed (102)
          Tests  323 passed (323)
       Duration  15.70s

    # typecheck
    > cross-agent-teams-mcp@0.1.0 typecheck
    > tsc --noEmit
    (exit 0, no output)
    ```
- [x] **REFACTOR:** None — already minimal
- [x] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
     RUN  v2.1.9 /Users/jtianling/workspace/cross-agent-teams-mcp-workspace/cross-agent-teams-mcp
     ✓ tests/delivery-spec.test.ts (8 tests) 2ms
     Test Files  1 passed (1)
          Tests  8 passed (8)
       Duration  122ms
    ```
- [x] **Commit:** `feat(lib): implement parseDeliveryRow (Task 1.2)`
  - **Commit SHA:** `515682d`

## TDD for 1.3 Implement `serializeDelivery(spec: DeliverySpec): { delivery_kind, delivery_payload }` inverse of 1.2
- kind: unit-test
- **Spec scenario(s):**
  - `agent-delivery/spec.md` → Scenario: `Writing kind 'none' sets payload to NULL`
  - `agent-delivery/spec.md` → Scenario: `Writing kind 'claude-channel' serializes channel_session_id into payload`
- **Files:**
  - Modify: `tests/delivery-spec.test.ts`
  - Modify: `src/lib/delivery-spec.ts`
- [x] **RED:** Add failing serialize tests: `{kind: 'none'}` → `{delivery_kind: 'none', delivery_payload: null}`; `{kind: 'claude-channel', channel_session_id: 'csid-abc'}` → exact JSON string form
- [x] **Verify RED:** run `pnpm test tests/delivery-spec.test.ts`, confirm failure
  - **Observed output:**
    ```
    FAIL  tests/delivery-spec.test.ts > serializeDelivery (Task 1.3) > serializes {kind: none} to {delivery_kind: none, delivery_payload: null}
    TypeError: serializeDelivery is not a function
     ❯ tests/delivery-spec.test.ts:92:12
    FAIL  tests/delivery-spec.test.ts > serializeDelivery (Task 1.3) > serializes claude-channel to JSON string payload with channel_session_id
    TypeError: serializeDelivery is not a function
    FAIL  tests/delivery-spec.test.ts > serializeDelivery (Task 1.3) > serializes codex-appserver to JSON payload with thread_id and ws_url
    TypeError: serializeDelivery is not a function
    FAIL  tests/delivery-spec.test.ts > serializeDelivery (Task 1.3) > serializes codex-appserver with optional auth_token_ref when present
    TypeError: serializeDelivery is not a function
    FAIL  tests/delivery-spec.test.ts > serializeDelivery (Task 1.3) > roundtrips parseDeliveryRow(serializeDelivery(spec)) === spec for each kind
    TypeError: serializeDelivery is not a function

     Test Files  1 failed (1)
          Tests  5 failed | 8 passed (13)
    ```
- [x] **GREEN:** Implement `serializeDelivery` as the inverse of `parseDeliveryRow`; add a roundtrip test that runs both directions
- [x] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    scoped: pnpm vitest run tests/delivery-spec.test.ts
     ✓ tests/delivery-spec.test.ts (13 tests) 2ms
     Test Files  1 passed (1)
          Tests  13 passed (13)

    full suite: pnpm vitest run
     Test Files  102 passed (102)
          Tests  328 passed (328)
       Duration  15.51s

    typecheck: pnpm typecheck
    > tsc --noEmit
    (exit 0, no errors)
    ```
- [x] **REFACTOR:** None — already minimal
- [x] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    No refactor applied; re-ran pnpm vitest run tests/delivery-spec.test.ts
     Test Files  1 passed (1)
          Tests  13 passed (13)
    ```
- [x] **Commit:** `feat(lib): implement serializeDelivery (Task 1.3)`
  - **Commit SHA:** `dea1f3a`

## TDD for 1.4 Implement `validateDeliveryForWrite(input): { ok: DeliverySpec } | { error: 'invalid_delivery', reason }` accepting `none` and `claude-channel` only; rejecting `codex-appserver` with reason `kind_not_yet_supported` and any other kind with `unknown_kind`
- kind: unit-test
- **Spec scenario(s):**
  - `agent-delivery/spec.md` → Scenario: `Write validator accepts kind 'none'`
  - `agent-delivery/spec.md` → Scenario: `Write validator accepts kind 'claude-channel' with valid channel_session_id`
  - `agent-delivery/spec.md` → Scenario: `Write validator rejects kind 'codex-appserver' in this change`
  - `agent-delivery/spec.md` → Scenario: `Write validator rejects unknown kind`
  - `agent-delivery/spec.md` → Scenario: `Write validator rejects kind 'claude-channel' missing channel_session_id`
- **Files:**
  - Modify: `tests/delivery-spec.test.ts`
  - Modify: `src/lib/delivery-spec.ts`
- [x] **RED:** Add failing validator tests covering all 5 scenarios above (accept × 2, reject × 3 with explicit `reason` values)
- [x] **Verify RED:** run `pnpm test tests/delivery-spec.test.ts`, confirm failure
  - **Observed output:**
    ```
    FAIL  tests/delivery-spec.test.ts > validateDeliveryForWrite (Task 1.4) > accepts {kind: none}
    TypeError: validateDeliveryForWrite is not a function
     ❯ tests/delivery-spec.test.ts:169:20
    FAIL  tests/delivery-spec.test.ts > validateDeliveryForWrite (Task 1.4) > accepts {kind: claude-channel, channel_session_id: ...}
    TypeError: validateDeliveryForWrite is not a function
    FAIL  tests/delivery-spec.test.ts > validateDeliveryForWrite (Task 1.4) > rejects {kind: codex-appserver} with reason kind_not_yet_supported
    TypeError: validateDeliveryForWrite is not a function
    FAIL  tests/delivery-spec.test.ts > validateDeliveryForWrite (Task 1.4) > rejects unknown kind with reason unknown_kind
    TypeError: validateDeliveryForWrite is not a function
    FAIL  tests/delivery-spec.test.ts > validateDeliveryForWrite (Task 1.4) > rejects claude-channel missing channel_session_id with reason missing_channel_session_id
    TypeError: validateDeliveryForWrite is not a function

     Test Files  1 failed (1)
          Tests  5 failed | 13 passed (18)
    ```
- [x] **GREEN:** Implement `validateDeliveryForWrite` per the spec's discriminated handling
- [x] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    Scoped: pnpm vitest run tests/delivery-spec.test.ts
     ✓ tests/delivery-spec.test.ts (18 tests) 2ms
     Test Files  1 passed (1)
          Tests  18 passed (18)

    Full suite: pnpm vitest run
     Test Files  102 passed (102)
          Tests  333 passed (333)
       Duration  15.77s

    Typecheck: pnpm typecheck → tsc --noEmit exit 0
    ```
- [x] **REFACTOR:** None — already minimal
- [x] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    Re-ran pnpm vitest run tests/delivery-spec.test.ts
     Test Files  1 passed (1)
          Tests  18 passed (18)
    ```
- [x] **Commit:** `feat(lib): implement validateDeliveryForWrite (Task 1.4)`
  - **Commit SHA:** `216c176`

## TDD for 1.5 Unit tests in `tests/delivery-spec.test.ts` covering serialize / parse roundtrip for each kind, corrupt payload, and validator accept/reject cases from `agent-delivery/spec.md`
- kind: unit-test
- **Spec scenario(s):**
  - `agent-delivery/spec.md` → every scenario under Requirements "DeliverySpec persistence maps to two columns" and "DeliverySpec validation rejects unknown kinds at write time" (coverage audit)
- **Files:**
  - Modify: `tests/delivery-spec.test.ts`
- [x] **RED:** Audit `tests/delivery-spec.test.ts` against the spec scenarios above; add any missing cases, ensure they fail if the feature is incomplete
- [x] **Verify RED:** run `pnpm test tests/delivery-spec.test.ts` against the pre-1.1..1.4 tree (if any audit gap is found the new case should fail); confirm every scenario row has at least one dedicated test
  - **Observed output:**
    ```
    Audit result: coverage from tasks 1.1-1.4 already exercises every scenario
    under "DeliverySpec persistence maps to two columns" and "DeliverySpec
    validation rejects unknown kinds at write time". Added an explicit
    "Task 1.5 scenario coverage audit" describe block mirroring each spec
    scenario 1:1 (11 new cases) so coverage is self-documenting and
    regression-proof. Since 1.1-1.4 implementation is already in tree, the
    new audit cases pass on first run (no RED gap detected):

     RUN  v2.1.9 /Users/jtianling/workspace/cross-agent-teams-mcp-workspace/cross-agent-teams-mcp
     ✓ tests/delivery-spec.test.ts (29 tests) 3ms
     Test Files  1 passed (1)
          Tests  29 passed (29)
       Duration  125ms
    ```
- [x] **GREEN:** If any gap was filled, ensure implementation still covers it (changes to `src/lib/delivery-spec.ts` only if needed)
- [x] **Verify GREEN:** re-run the full suite, confirm pass
  - **Observed output:**
    ```
    $ pnpm vitest run
     Test Files  102 passed (102)
          Tests  344 passed (344)
       Duration  15.41s

    $ pnpm typecheck
    (tsc --noEmit, exit 0)
    ```
- [x] **REFACTOR:** None — already minimal
- [x] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    No refactor applied; targeted suite still green:
     ✓ tests/delivery-spec.test.ts (29 tests)
     Test Files  1 passed (1)
          Tests  29 passed (29)
    ```
- [x] **Commit:** `test(lib): close scenario coverage for delivery-spec (Task 1.5)`
  - **Commit SHA:** `f86b6cb`

## TDD for 2.1 Update `src/storage/schema.ts` to include `delivery_kind TEXT NOT NULL DEFAULT 'none'` and `delivery_payload TEXT` in the `CREATE TABLE agents` statement for fresh databases
- kind: unit-test
- **Spec scenario(s):**
  - `agent-registry/spec.md` → Scenario: `Fresh database creates agents table with delivery_kind and delivery_payload columns`
  - `agent-registry/spec.md` → Scenario: `Fresh database still creates agents table with channel_session_id column`
- **Files:**
  - Modify: `src/storage/schema.ts`
  - Modify: `tests/agents-schema.test.ts` (or nearest existing schema-assertion test)
- [x] **RED:** Add failing schema assertions: on a fresh DB, `PRAGMA table_info('agents')` lists `delivery_kind` TEXT NOT NULL DEFAULT 'none' and `delivery_payload` TEXT NULL; legacy `channel_session_id` still present
- [x] **Verify RED:** run the targeted test; confirm failure
  - **Observed output:**
    ```
     FAIL  tests/agents-schema.test.ts > agents schema > creates agents table with required columns and name is NOT NULL
    AssertionError: expected [ 'agent_id', …(9) ] to deeply equal [ 'agent_id', …(11) ]
    - Expected
    + Received
      Array [
        "agent_id",
        "channel_session_id",
    -   "delivery_kind",
    -   "delivery_payload",
        "last_processed_event_id",
        ...
      ]
     FAIL  tests/agents-schema.test.ts > agents schema > creates agents table with delivery_kind and delivery_payload columns
    AssertionError: expected undefined to be defined
     ❯ tests/agents-schema.test.ts:40:26
         39|     const deliveryKind = cols.find(c => c.name === 'delivery_kind')
         40|     expect(deliveryKind).toBeDefined()
     Test Files  1 failed (1)
          Tests  2 failed | 1 passed (3)
    ```
- [x] **GREEN:** Update the `CREATE TABLE agents` DDL in `schema.ts` to add the two columns with exact types/defaults
- [x] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
     ✓ tests/agents-schema.test.ts (3 tests) 8ms
     Test Files  1 passed (1)
          Tests  3 passed (3)

    Full suite:
     Test Files  102 passed (102)
          Tests  345 passed (345)
       Duration  15.59s
    pnpm typecheck: tsc --noEmit exit 0
    ```
- [x] **REFACTOR:** None — already minimal
- [x] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    No refactor performed; re-ran targeted test:
     ✓ tests/agents-schema.test.ts (3 tests) 8ms
     Test Files  1 passed (1)
          Tests  3 passed (3)
    ```
- [x] **Commit:** `feat(storage): add delivery_kind/delivery_payload columns to agents DDL (Task 2.1)`
  - **Commit SHA:** `9aae562`

## TDD for 2.2 Add idempotent startup migration in the schema bootstrap path: detect missing columns via `PRAGMA table_info('agents')`, run `ALTER TABLE agents ADD COLUMN delivery_kind ...` and `ALTER TABLE agents ADD COLUMN delivery_payload TEXT` only when missing, wrapped in a transaction
- kind: integration-test
- **Spec scenario(s):**
  - `agent-registry/spec.md` → Scenario: `Startup migration on old schema adds both columns`
  - `agent-registry/spec.md` → Scenario: `Startup migration is idempotent`
- **Files:**
  - Modify: `src/storage/schema.ts` (or the bootstrap entry point)
  - Create: `tests/migration-delivery-columns.test.ts`
- [x] **INTEGRATION-RED:** Seed a `better-sqlite3` DB whose `agents` table lacks `delivery_kind`/`delivery_payload`; run the bootstrap; assert columns exist afterwards with correct PRAGMA; then run bootstrap a second time and assert no error, no duplicate ALTER (e.g. by capturing executed SQL or verifying idempotent outcome). The test must fail before 2.2 implementation lands.
- [x] **Verify RED:** run `pnpm test tests/migration-delivery-columns.test.ts`, confirm failure
  - **Observed output:**
    ```
     ❯ tests/migration-delivery-columns.test.ts (3 tests | 2 failed) 10ms
       × migration: delivery columns > adds delivery_kind and delivery_payload to a pre-existing old-schema agents table 6ms
         → expected undefined to be defined
       × migration: delivery columns > is idempotent: running applySchema twice does not error and leaves columns intact 3ms
         → expected [ 'agent_id', …(9) ] to include 'delivery_kind'
     Test Files  1 failed (1)
          Tests  2 failed | 1 passed (3)
    ```
- [x] **INTEGRATION-GREEN:** Implement idempotent bootstrap: detect via `PRAGMA table_info('agents')`; conditionally ALTER; wrap in a transaction
- [x] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
     ✓ tests/migration-delivery-columns.test.ts (3 tests) 10ms
     Test Files  1 passed (1)
          Tests  3 passed (3)

    full-suite summary:
     Test Files  103 passed (103)
          Tests  348 passed (348)
       Duration  15.79s
    ```
- [x] **REFACTOR:** None — already minimal
- [x] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    Re-ran full suite after refactor review (no code changes):
     Test Files  103 passed (103)
          Tests  348 passed (348)
    ```
- [x] **Commit:** `feat(storage): idempotent startup migration adds delivery columns (Task 2.2)`
  - **Commit SHA:** `8f2b7b4`

## TDD for 2.3 Add one-shot backfill in the same migration: `UPDATE agents SET delivery_kind='claude-channel', delivery_payload=json_object('channel_session_id', channel_session_id) WHERE channel_session_id IS NOT NULL AND delivery_kind='none'`
- kind: integration-test
- **Spec scenario(s):**
  - `agent-registry/spec.md` → Scenario: `Startup migration backfills claude-channel rows`
- **Files:**
  - Modify: `src/storage/schema.ts`
  - Modify: `tests/migration-delivery-columns.test.ts`
- [x] **INTEGRATION-RED:** Extend the migration test: seed rows with `channel_session_id='csid-abc'` BEFORE the new columns exist; run bootstrap; assert the row has `delivery_kind='claude-channel'` and `delivery_payload='{"channel_session_id":"csid-abc"}'`. Also seed a row with `channel_session_id=NULL`; assert it stays `delivery_kind='none'`, `delivery_payload IS NULL`.
- [x] **Verify RED:** run `pnpm test tests/migration-delivery-columns.test.ts`, confirm failure
  - **Observed output:**
    ```
     ❯ tests/migration-delivery-columns.test.ts (5 tests | 2 failed) 45ms
       × migration: delivery columns > backfills delivery_kind/delivery_payload from channel_session_id during migration 4ms
         → expected 'none' to be 'claude-channel' // Object.is equality
       × migration: delivery columns > backfill is idempotent: running applySchema again does not overwrite existing delivery data 2ms
         → expected 'none' to be 'claude-channel' // Object.is equality
    AssertionError: expected 'none' to be 'claude-channel' // Object.is equality
    Expected: "claude-channel"
    Received: "none"
     ❯ tests/migration-delivery-columns.test.ts:106:32
     Test Files  1 failed (1)
          Tests  2 failed | 3 passed (5)
    ```
- [x] **INTEGRATION-GREEN:** Add the one-shot UPDATE inside the same bootstrap transaction, guarded by `channel_session_id IS NOT NULL AND delivery_kind='none'`
- [x] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    scoped:
     ✓ tests/migration-delivery-columns.test.ts (5 tests) 14ms
     Test Files  1 passed (1)
          Tests  5 passed (5)
    full suite:
     Test Files  103 passed (103)
          Tests  350 passed (350)
       Duration  15.81s
    typecheck:
    > tsc --noEmit  (exit 0, no output)
    ```
- [x] **REFACTOR:** None — already minimal
- [x] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
     Test Files  103 passed (103)
          Tests  350 passed (350)
    ```
- [x] **Commit:** `feat(storage): backfill delivery from legacy channel_session_id on migration (Task 2.3)`
  - **Commit SHA:** `d73d2e2`

## TDD for 2.4 Verify migration leaves legacy `channel_session_id` column and its values untouched
- kind: integration-test
- **Spec scenario(s):**
  - `agent-registry/spec.md` → Scenario: `Startup migration leaves channel_session_id column untouched`
- **Files:**
  - Modify: `tests/migration-delivery-columns.test.ts`
- [ ] **INTEGRATION-RED:** Add a case: seed rows with `channel_session_id='csid-abc'`; after migration, assert the legacy column's value is still `'csid-abc'` (not cleared, not rewritten).
- [ ] **Verify RED:** run the targeted test; confirm failure if legacy column handling is broken
  - **Observed output:**
    ```
    ```
- [ ] **INTEGRATION-GREEN:** Inspect migration SQL; if necessary, add a post-migration assertion helper; ensure no migration statement mutates the legacy column
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `test(storage): assert migration preserves legacy channel_session_id (Task 2.4)`
  - **Commit SHA:** ``

## TDD for 2.5 Tests: fresh-db schema assertions (PRAGMA table_info columns, defaults, notnull flags) matching scenarios in `agent-registry/spec.md`
- kind: unit-test
- **Spec scenario(s):**
  - `agent-registry/spec.md` → Scenario: `Fresh database creates agents table with delivery_kind and delivery_payload columns`
  - `agent-registry/spec.md` → Scenario: `Fresh database still creates agents table with channel_session_id column`
- **Files:**
  - Modify: `tests/agents-schema.test.ts` (or the fresh-db schema test file)
- [ ] **RED:** Audit the fresh-db PRAGMA tests; ensure every field of the two scenarios above is asserted (column exists, type, notnull, default); add missing assertions so they fail if `src/storage/schema.ts` is incomplete
- [ ] **Verify RED:** run the targeted test against an incomplete schema; confirm failure
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Confirm 2.1 implementation covers the assertions; no further production change expected
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `test(storage): close PRAGMA assertions for delivery columns (Task 2.5)`
  - **Commit SHA:** ``

## TDD for 2.6 Tests: migration-from-old-schema — seed a DB that lacks `delivery_*` columns but has rows with `channel_session_id`, run startup, assert columns exist and backfill applied exactly to matching rows
- kind: integration-test
- **Spec scenario(s):**
  - `agent-registry/spec.md` → Scenario: `Startup migration on old schema adds both columns`
  - `agent-registry/spec.md` → Scenario: `Startup migration backfills claude-channel rows`
- **Files:**
  - Modify: `tests/migration-delivery-columns.test.ts`
- [ ] **INTEGRATION-RED:** Audit the migration test; ensure the "seed → bootstrap → assert columns + backfill" case covers both scenarios end-to-end (precise PRAGMA + exact JSON payload assertion). Add missing assertions.
- [ ] **Verify RED:** run the targeted test; confirm any audit gap surfaces as a failure
  - **Observed output:**
    ```
    ```
- [ ] **INTEGRATION-GREEN:** Confirm 2.2 + 2.3 implementations cover the assertions; no production change expected
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `test(storage): close migration-from-old-schema coverage (Task 2.6)`
  - **Commit SHA:** ``

## TDD for 2.7 Tests: migration idempotence — run startup twice, assert second run does no ALTER and does not overwrite values
- kind: integration-test
- **Spec scenario(s):**
  - `agent-registry/spec.md` → Scenario: `Startup migration is idempotent`
- **Files:**
  - Modify: `tests/migration-delivery-columns.test.ts`
- [ ] **INTEGRATION-RED:** Seed a migrated DB with non-default `delivery_kind`/`delivery_payload`; run bootstrap a second time; assert values unchanged and no error; (optional) spy on executed SQL to confirm no ALTER on second run
- [ ] **Verify RED:** run the targeted test against a non-idempotent bootstrap; confirm failure
  - **Observed output:**
    ```
    ```
- [ ] **INTEGRATION-GREEN:** Confirm 2.2's detection gate (PRAGMA-before-ALTER) is robust; no production change expected
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `test(storage): assert migration idempotence (Task 2.7)`
  - **Commit SHA:** ``

## TDD for 3.1 Extend `AgentsRepo.register(...)` (in `src/storage/agents-repo.ts`) to accept `delivery?: DeliverySpec`; default to `{kind: 'none'}` when omitted
- kind: unit-test
- **Spec scenario(s):**
  - `agent-registry/spec.md` → Scenario: `register_agent without delivery preserves existing default behavior`
- **Files:**
  - Modify: `src/storage/agents-repo.ts`
  - Create: `tests/agents-repo-delivery.test.ts`
- [ ] **RED:** Add failing test: call `AgentsRepo.register` without `delivery`; row has `delivery_kind='none'`, `delivery_payload IS NULL`
- [ ] **Verify RED:** run `pnpm test tests/agents-repo-delivery.test.ts`, confirm failure
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Add optional `delivery?: DeliverySpec` param; serialize via `serializeDelivery` (Task 1.3); default to `{kind: 'none'}`
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `feat(storage): AgentsRepo.register accepts DeliverySpec (Task 3.1)`
  - **Commit SHA:** ``

## TDD for 3.2 Add `AgentsRepo.setDelivery(agent_id, spec: DeliverySpec): void` that runs the `UPDATE agents SET delivery_kind=?, delivery_payload=? WHERE agent_id=?` statement atomically using `serializeDelivery`
- kind: unit-test
- **Spec scenario(s):**
  - (Supports `agent-delivery` persistence; enabler for `bind_channel` refactor in 5.1)
- **Files:**
  - Modify: `src/storage/agents-repo.ts`
  - Modify: `tests/agents-repo-delivery.test.ts`
- [ ] **RED:** Add failing tests: `setDelivery(id, {kind: 'claude-channel', channel_session_id: 'csid-abc'})` updates both columns atomically; subsequent `setDelivery(id, {kind: 'none'})` clears payload to NULL; setDelivery on unknown agent_id is a no-op (or error — decision to be confirmed in implementation)
- [ ] **Verify RED:** run `pnpm test tests/agents-repo-delivery.test.ts`, confirm failure
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Implement `setDelivery` using `serializeDelivery`; single UPDATE statement
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `feat(storage): AgentsRepo.setDelivery (Task 3.2)`
  - **Commit SHA:** ``

## TDD for 3.3 Update `AgentsRepo` read methods (`getById`, `list`, any `list_agents` backing query) to return rows with the reconstructed `delivery: DeliverySpec` field via `parseDeliveryRow`
- kind: unit-test
- **Spec scenario(s):**
  - `agent-delivery/spec.md` → Scenario: `Reading back a kind 'claude-channel' row reconstructs the spec`
  - `agent-registry/spec.md` → Scenario: `list_agents surfaces delivery for kind 'claude-channel'`
  - `agent-registry/spec.md` → Scenario: `list_agents surfaces delivery kind 'none' for agents with no channel`
- **Files:**
  - Modify: `src/storage/agents-repo.ts`
  - Modify: `tests/agents-repo-delivery.test.ts`
- [ ] **RED:** Add failing tests: `getById` and `list` return `delivery: DeliverySpec` shaped correctly for kind 'none' and kind 'claude-channel' rows
- [ ] **Verify RED:** run targeted test; confirm failure
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Thread `parseDeliveryRow` through read paths; update return types
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `feat(storage): AgentsRepo read paths return DeliverySpec (Task 3.3)`
  - **Commit SHA:** ``

## TDD for 3.4 Add a `channel_session_id` derived accessor in the row-shape exposed by `AgentsRepo` (equals `delivery.channel_session_id` when `kind === 'claude-channel'`, else `null`)
- kind: unit-test
- **Spec scenario(s):**
  - `agent-delivery/spec.md` → Scenario: `derived channel_session_id for claude-channel delivery`
  - `agent-delivery/spec.md` → Scenario: `derived channel_session_id is null for other kinds`
- **Files:**
  - Modify: `src/storage/agents-repo.ts`
  - Modify: `tests/agents-repo-delivery.test.ts`
- [ ] **RED:** Add failing tests: row with kind 'claude-channel' exposes derived `channel_session_id='csid-abc'`; rows with kind 'none' expose `null`
- [ ] **Verify RED:** run targeted test; confirm failure
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Add derivation (either getter on row object or projection in repo method) consistent across `getById` / `list`
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `feat(storage): derive channel_session_id from delivery (Task 3.4)`
  - **Commit SHA:** ``

## TDD for 3.5 Audit all AgentsRepo SQL to confirm no statement writes directly to the legacy `channel_session_id` column after this change; grep `channel_session_id\\s*=` inside `agents-repo.ts` should return zero matches in write paths
- kind: unit-test
- **Spec scenario(s):**
  - `agent-registry/spec.md` → Scenario: `No write path updates the legacy column directly`
- **Files:**
  - Modify: `src/storage/agents-repo.ts` (only if findings require)
  - Create: `tests/agents-repo-no-legacy-writes.test.ts`
- [ ] **RED:** Add a test that reads `src/storage/agents-repo.ts` source and asserts no match for `/UPDATE\s+agents[\s\S]*?channel_session_id\s*=/i` and no `INSERT INTO agents ... channel_session_id` in column-list position
- [ ] **Verify RED:** run the test against a tree that still contains such a write; confirm failure
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Remove or rewrite any offending SQL to use `setDelivery` instead
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `refactor(storage): drop legacy channel_session_id writes in AgentsRepo (Task 3.5)`
  - **Commit SHA:** ``

## TDD for 3.6 Tests: `tests/agents-repo-delivery.test.ts` — register with each supported kind, read back, assert delivery shape; `setDelivery` overwrite semantics; derived `channel_session_id` getter correctness
- kind: unit-test
- **Spec scenario(s):**
  - `agent-delivery/spec.md` → Scenario: `derived channel_session_id for claude-channel delivery`
  - `agent-delivery/spec.md` → Scenario: `derived channel_session_id is null for other kinds`
- **Files:**
  - Modify: `tests/agents-repo-delivery.test.ts`
- [ ] **RED:** Audit test file; ensure coverage of all three behaviors (register variants, setDelivery overwrite, derived accessor); add any missing cases so they fail without 3.1–3.4 in place
- [ ] **Verify RED:** run the test; confirm any gap surfaces as a failure
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Confirm 3.1–3.4 cover all added cases; no production change expected
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `test(storage): close AgentsRepo delivery coverage (Task 3.6)`
  - **Commit SHA:** ``

## TDD for 4.1 Extend input schema of `register_agent` (in `src/mcp/register-agent.ts` and zod schema in `src/mcp/tools.ts` or equivalent) with optional `delivery` field matching `DeliverySpec`
- kind: unit-test
- **Spec scenario(s):**
  - `agent-registry/spec.md` → Scenario: `register_agent without delivery preserves existing default behavior`
- **Files:**
  - Modify: `src/mcp/register-agent.ts`
  - Modify: `src/mcp/tools.ts`
  - Create: `tests/register-agent-delivery.test.ts`
- [ ] **RED:** Add failing test: `register_agent({team, name, model})` succeeds with no `delivery` field; returning row has `delivery={kind: 'none'}`
- [ ] **Verify RED:** run `pnpm test tests/register-agent-delivery.test.ts`, confirm failure
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Extend zod schema with optional `delivery` matching `DeliverySpec`; default-apply `{kind: 'none'}` when absent
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `feat(mcp): register_agent accepts optional delivery (Task 4.1)`
  - **Commit SHA:** ``

## TDD for 4.2 Before the repo call, validate `delivery` with `validateDeliveryForWrite`; on failure return `{error: 'invalid_delivery', reason}` without DB write
- kind: unit-test
- **Spec scenario(s):**
  - `agent-registry/spec.md` → Scenario: `register_agent with invalid delivery rejects without inserting`
- **Files:**
  - Modify: `src/mcp/register-agent.ts`
  - Modify: `tests/register-agent-delivery.test.ts`
- [ ] **RED:** Add failing test: calling with `delivery={kind: 'claude-channel'}` (missing `channel_session_id`) returns `{error: 'invalid_delivery', reason: 'missing_channel_session_id'}` and leaves the agents table unchanged
- [ ] **Verify RED:** run the targeted test; confirm failure
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Call `validateDeliveryForWrite` pre-repo; on `error` return the structured error and short-circuit before any DB write
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `feat(mcp): register_agent rejects invalid delivery without writing (Task 4.2)`
  - **Commit SHA:** ``

## TDD for 4.3 On success, pass the validated `DeliverySpec` to `AgentsRepo.register` so identity + delivery are persisted atomically
- kind: unit-test
- **Spec scenario(s):**
  - `agent-registry/spec.md` → Scenario: `register_agent with delivery kind 'claude-channel' persists both columns atomically`
- **Files:**
  - Modify: `src/mcp/register-agent.ts`
  - Modify: `tests/register-agent-delivery.test.ts`
- [ ] **RED:** Add failing test: call with valid `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}`; inspect the stored row — both identity and delivery fields present in one row
- [ ] **Verify RED:** run the targeted test; confirm failure
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Wire validated spec through to `AgentsRepo.register`'s new `delivery` param
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `feat(mcp): register_agent persists delivery atomically (Task 4.3)`
  - **Commit SHA:** ``

## TDD for 4.4 Ensure existing re-registration semantics (idempotent for same `(team, name)`) preserve any previously-persisted non-`none` delivery when the new call omits `delivery`
- kind: unit-test
- **Spec scenario(s):**
  - (Defends backward compatibility of existing `register_agent` idempotence with the new field.)
- **Files:**
  - Modify: `src/mcp/register-agent.ts` or `src/storage/agents-repo.ts` (wherever re-registration collapse lives)
  - Modify: `tests/register-agent-delivery.test.ts`
- [ ] **RED:** Add failing test: register alice with `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}`; then re-register alice with same (team, name, model) but no `delivery`; expect alice's `delivery` to still be kind 'claude-channel' with the same `channel_session_id`
- [ ] **Verify RED:** run the targeted test; confirm failure (typical failure mode: re-registration resets to kind 'none')
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Ensure the re-registration path treats missing `delivery` as "don't change"; only write `delivery` when the caller supplied it
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `fix(mcp): re-registration preserves previous delivery when omitted (Task 4.4)`
  - **Commit SHA:** ``

## TDD for 4.5 Tests: `tests/register-agent-delivery.test.ts` — register without delivery (asserts `kind='none'`); register with `claude-channel` delivery (asserts row has both identity + delivery atomically); register with invalid `claude-channel` (missing `channel_session_id`) returns error and writes no row; register with `codex-appserver` returns `kind_not_yet_supported`
- kind: unit-test
- **Spec scenario(s):**
  - `agent-registry/spec.md` → every scenario under Requirement "register_agent accepts optional delivery field" (coverage audit)
  - `agent-delivery/spec.md` → Scenario: `Write validator rejects kind 'codex-appserver' in this change` (via register_agent surface)
- **Files:**
  - Modify: `tests/register-agent-delivery.test.ts`
- [ ] **RED:** Audit the test file; ensure coverage of all four register_agent behaviors above; add the `codex-appserver` rejection case if missing; ensure they fail against an incomplete 4.1–4.4 implementation
- [ ] **Verify RED:** run the test; confirm any gap surfaces as a failure
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Confirm 4.1–4.4 implementation covers all added cases; no further production change expected
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `test(mcp): close register_agent delivery scenarios (Task 4.5)`
  - **Commit SHA:** ``

## TDD for 5.1 Change `bind_channel` handler so step 5 (on all prior validations passing) calls `AgentsRepo.setDelivery(caller_agent_id, {kind: 'claude-channel', channel_session_id})` instead of direct `UPDATE agents SET channel_session_id = ...`
- kind: unit-test
- **Spec scenario(s):**
  - `claude-channel-transport/spec.md` → Scenario: `bind_channel updates caller's agents row when csid has live sink`
- **Files:**
  - Modify: `src/mcp/tools.ts` (or wherever `bind_channel` handler lives)
  - Modify: `tests/bind-channel.test.ts`
- [ ] **RED:** Update bind-channel test to assert the success path sets `delivery_kind='claude-channel'` and parsed `delivery_payload.channel_session_id='csid-abc'`; assertion fails before 5.1 implementation
- [ ] **Verify RED:** run `pnpm test tests/bind-channel.test.ts`, confirm failure
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Replace direct UPDATE with a call to `AgentsRepo.setDelivery`
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `refactor(mcp): bind_channel writes via AgentsRepo.setDelivery (Task 5.1)`
  - **Commit SHA:** ``

## TDD for 5.2 Confirm response schema (`{ok: true}` / `{error: ...}`) and error codes (`unknown_agent`, `forbidden_role`, `invalid_channel_session_id`, `unknown_channel_session`) are unchanged
- kind: unit-test
- **Spec scenario(s):**
  - `claude-channel-transport/spec.md` → Scenario: `bind_channel rejects unknown channel_session_id`
  - `claude-channel-transport/spec.md` → Scenario: `bind_channel rejects proxy caller`
- **Files:**
  - Modify: `tests/bind-channel.test.ts`
- [ ] **RED:** Audit all existing bind-channel error paths; ensure each of the four error codes has an assertion; ensure they still hold post-5.1 (no regression in surface)
- [ ] **Verify RED:** run the targeted test against a regressed surface; confirm failure if any error code has been altered
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Confirm 5.1's refactor preserves all error branches; no production change expected
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `test(mcp): pin bind_channel error surface post-refactor (Task 5.2)`
  - **Commit SHA:** ``

## TDD for 5.3 Update existing `tests/bind-channel.test.ts` assertions: after successful bind, check `delivery_kind='claude-channel'` and parsed `delivery_payload.channel_session_id` instead of legacy column
- kind: unit-test
- **Spec scenario(s):**
  - `claude-channel-transport/spec.md` → Scenario: `bind_channel updates caller's agents row when csid has live sink`
  - `claude-channel-transport/spec.md` → Scenario: `bind_channel rejects unknown channel_session_id` (unchanged row assertion)
  - `claude-channel-transport/spec.md` → Scenario: `bind_channel rejects proxy caller`
- **Files:**
  - Modify: `tests/bind-channel.test.ts`
- [ ] **RED:** Sweep the test file; replace every "assert legacy `channel_session_id` column value" assertion with the equivalent "assert `delivery_kind`/parsed `delivery_payload`" form; assertions fail if 5.1 somehow regresses
- [ ] **Verify RED:** run the test against an intermediate tree; confirm the new-form assertions fail when appropriate
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Confirm 5.1 lands cleanly; no further production change
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `test(mcp): rewrite bind-channel assertions to check delivery (Task 5.3)`
  - **Commit SHA:** ``

## TDD for 5.4 Add a test that asserts the legacy `channel_session_id` column is left at its pre-call value after successful bind (confirms no direct write)
- kind: unit-test
- **Spec scenario(s):**
  - `claude-channel-transport/spec.md` → Scenario: `bind_channel does not touch legacy channel_session_id column`
- **Files:**
  - Modify: `tests/bind-channel.test.ts`
- [ ] **RED:** Add test: seed alice with legacy `channel_session_id IS NULL` and `delivery_kind='none'`; run a successful `bind_channel({channel_session_id: 'csid-abc'})`; assert the legacy column is still `NULL`, and `delivery_kind='claude-channel'`
- [ ] **Verify RED:** run the test against a pre-5.1 tree (which still UPDATEs the legacy column); confirm failure
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Confirm 5.1 eliminates the legacy column write; no further production change
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `test(mcp): assert bind_channel leaves legacy column untouched (Task 5.4)`
  - **Commit SHA:** ``

## TDD for 6.1 Update `list_agents` handler to include the `delivery: DeliverySpec` field in each entry of its response
- kind: unit-test
- **Spec scenario(s):**
  - `agent-registry/spec.md` → Scenario: `list_agents surfaces delivery for kind 'claude-channel'`
  - `agent-registry/spec.md` → Scenario: `list_agents surfaces delivery kind 'none' for agents with no channel`
- **Files:**
  - Modify: `src/mcp/tools.ts` (list_agents handler)
  - Modify: `tests/agents-repo-list-channel-session-id.test.ts` (or add `tests/list-agents-delivery.test.ts`)
- [ ] **RED:** Add failing test: seed alice (kind 'claude-channel', csid-abc) and bob (kind 'none'); assert `list_agents({})` returns `alice.delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}` and `bob.delivery={kind: 'none'}`
- [ ] **Verify RED:** run `pnpm test tests/list-agents-delivery.test.ts` (or the expanded existing file), confirm failure
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Thread `AgentsRepo`'s reconstructed `delivery` through the handler's response serializer
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `feat(mcp): list_agents returns delivery field (Task 6.1)`
  - **Commit SHA:** ``

## TDD for 6.2 Keep the existing `channel_session_id: string | null` field in each entry, sourced from the derived accessor (not from a direct column read)
- kind: unit-test
- **Spec scenario(s):**
  - `agent-registry/spec.md` → Scenario: `list_agents surfaces derived channel_session_id for claude-channel delivery`
  - `agent-registry/spec.md` → Scenario: `list_agents returns null channel_session_id for non-claude delivery kinds`
- **Files:**
  - Modify: `src/mcp/tools.ts` (list_agents handler)
  - Modify: `tests/list-agents-delivery.test.ts` (or expand existing file)
- [ ] **RED:** Add failing test: assert `alice.channel_session_id='csid-abc'` (derived) and `bob.channel_session_id=null`; both sourced from delivery, not from any direct DB column read
- [ ] **Verify RED:** run the targeted test; confirm failure
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Replace any direct `row.channel_session_id` read in the handler with `AgentsRepo`'s derived accessor (Task 3.4)
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `refactor(mcp): list_agents derives channel_session_id from delivery (Task 6.2)`
  - **Commit SHA:** ``

## TDD for 6.3 Tests: update `tests/agents-repo-list-channel-session-id.test.ts` and any `list_agents` tests to assert both fields; add scenarios matching `agent-registry/spec.md` MODIFIED requirement ("list_agents returns channel_session_id field")
- kind: unit-test
- **Spec scenario(s):**
  - `agent-registry/spec.md` → every scenario under Requirement "list_agents returns delivery field" and MODIFIED "list_agents returns channel_session_id field" (coverage audit)
- **Files:**
  - Modify: `tests/agents-repo-list-channel-session-id.test.ts`
- [ ] **RED:** Audit the test file; migrate legacy-column assertions to the new shape; ensure all four scenarios covered; add any missing cases so they fail against an incomplete 6.1/6.2
- [ ] **Verify RED:** run the test; confirm gaps surface as failures
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Confirm 6.1 + 6.2 cover all added cases; no further production change expected
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `test(mcp): close list_agents delivery+csid coverage (Task 6.3)`
  - **Commit SHA:** ``

## TDD for 7.1 Locate the existing dispatcher code path that reads `channel_session_id` before selecting `ChannelWakeFanout` vs tmux fallback (likely in the send-message / poke handlers)
- kind: manual-verify
- verify: grep the codebase (`src/**/*.ts`) for reads of `channel_session_id` in dispatch / send-message / poke code; record the exact file path and function where the branch lives, including the line range; this recorded location is the input for Task 7.2
- **Spec scenario(s):**
  - (Enabler for 7.2; no spec scenario directly attributed.)
- **Files:**
  - Read-only: `src/**/*.ts` (no writes expected)
- [ ] **IMPLEMENT:** Perform the grep; identify the branch(es); record `file:line_range` in the Evidence block
- [ ] **MANUAL-VERIFY:** Inspect the recorded branch; confirm it is in fact the poke dispatch site; confirm the surrounding function signature makes sense for the 7.2 refactor → [ok|partial|fail]
  - **Evidence:**
    ```
    ```
- [ ] **Commit:** `docs(dispatch): record legacy dispatcher site for delivery refactor (Task 7.1)` (commit the manual-verify notes alongside any trivial comments if added; if no file changes, mark this task with an empty-tree commit or absorb into 7.2 and note here)
  - **Commit SHA:** ``

## TDD for 7.2 Replace the read with a `DeliverySpec` switch on `kind`
- kind: unit-test
- **Spec scenario(s):**
  - `agent-delivery/spec.md` → Scenario: `Route kind 'claude-channel' to ChannelWakeFanout`
  - `agent-delivery/spec.md` → Scenario: `Route kind 'none' to tmux when pane is set`
  - `agent-delivery/spec.md` → Scenario: `Route kind 'none' with no tmux returns no_transport_available`
  - `agent-delivery/spec.md` → Scenario: `kind 'codex-appserver' returns dispatcher_not_implemented in this change`
- **Files:**
  - Modify: (file from Task 7.1)
  - Create: `tests/poke-dispatch-routing.test.ts`
- [ ] **RED:** Write failing tests for each of the four scenarios above — `tests/poke-dispatch-routing.test.ts`
- [ ] **Verify RED:** run `pnpm test tests/poke-dispatch-routing.test.ts`, confirm failure
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Rewrite the dispatch branch to switch on `delivery.kind`; wire `'claude-channel'` to `ChannelWakeFanout`, `'none'` to tmux-or-`no_transport_available`, `'codex-appserver'` to a stub returning `{error: 'dispatcher_not_implemented'}`
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `refactor(daemon): dispatch by delivery.kind (Task 7.2)`
  - **Commit SHA:** ``

## TDD for 7.3 Tests: `tests/poke-dispatch-routing.test.ts` covering each case from `agent-delivery/spec.md` "Poke dispatch routes by delivery.kind"
- kind: unit-test
- **Spec scenario(s):**
  - `agent-delivery/spec.md` → every scenario under Requirement "Poke dispatch routes by delivery.kind" (coverage audit)
- **Files:**
  - Modify: `tests/poke-dispatch-routing.test.ts`
- [ ] **RED:** Audit the test file; ensure each of the four routing scenarios has a dedicated case; add any missing; ensure they fail against an incomplete 7.2 implementation
- [ ] **Verify RED:** run the test; confirm gaps surface as failures
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** Confirm 7.2 covers all added cases; no further production change expected
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `test(daemon): close poke-dispatch-routing coverage (Task 7.3)`
  - **Commit SHA:** ``

## TDD for 8.1 Grep codebase for remaining direct reads of the legacy `channel_session_id` column outside AgentsRepo; migrate to `delivery`-based access or the derived accessor
- kind: manual-verify
- verify: `grep -rn 'channel_session_id' src/ tests/ | grep -v 'agents-repo' | grep -v 'test'` — for each hit outside AgentsRepo and outside test fixtures, record file:line and either migrate to the derived accessor (if production code) or justify why it stays (if test seeding for migration test)
- **Spec scenario(s):**
  - `agent-registry/spec.md` → Scenario: `No write path updates the legacy column directly` (read-side sweep supports the MODIFIED requirement indirectly)
- **Files:**
  - Modify: (any production file that still reads the legacy column directly)
- [ ] **IMPLEMENT:** Perform the grep; for each non-AgentsRepo hit, migrate the call site or log its justification
- [ ] **MANUAL-VERIFY:** Re-run the grep post-edit; outside AgentsRepo and test fixtures, the only acceptable remaining hits are the ones justified in writing here → [ok|partial|fail]
  - **Evidence:**
    ```
    ```
- [ ] **Commit:** `refactor(*): migrate direct channel_session_id reads to delivery accessor (Task 8.1)`
  - **Commit SHA:** ``

## TDD for 8.2 Grep codebase for remaining writes (`UPDATE agents SET channel_session_id` or `INSERT INTO agents (... channel_session_id ...)`) — expected count: 0 in daemon code after this change (test fixtures may still seed the legacy column directly to exercise migration)
- kind: manual-verify
- verify: `grep -rn 'channel_session_id' src/` and `grep -rn 'UPDATE agents' src/` — tally any SQL that writes to the legacy column; the expected daemon-code count is 0; any remaining hits must be in test fixtures / migration tooling
- **Spec scenario(s):**
  - `agent-registry/spec.md` → Scenario: `No write path updates the legacy column directly`
- **Files:**
  - Modify: (any production file still writing the legacy column)
- [ ] **IMPLEMENT:** Perform the grep; for each match in `src/`, rewrite to use `AgentsRepo.setDelivery` or justify
- [ ] **MANUAL-VERIFY:** Re-run the grep post-edit; confirm zero matches in `src/` (test fixtures in `tests/` for migration tests are OK and must be noted here) → [ok|partial|fail]
  - **Evidence:**
    ```
    ```
- [ ] **Commit:** `refactor(*): remove remaining legacy channel_session_id writes (Task 8.2)`
  - **Commit SHA:** ``

## TDD for 8.3 Add a lint-style test (`tests/no-direct-channel-column-writes.test.ts`) that statically scans `src/**/*.ts` for `UPDATE agents SET channel_session_id` to prevent regressions
- kind: unit-test
- **Spec scenario(s):**
  - `agent-registry/spec.md` → Scenario: `No write path updates the legacy column directly`
- **Files:**
  - Create: `tests/no-direct-channel-column-writes.test.ts`
- [ ] **RED:** Write failing test — open every `src/**/*.ts` file and assert none match `/UPDATE\s+agents[\s\S]*?channel_session_id\s*=/i` (this fails if 8.2 missed anything)
- [ ] **Verify RED:** intentionally inject a test-only regression in a scratch branch to confirm the test fails; revert before commit
  - **Observed output:**
    ```
    ```
- [ ] **GREEN:** With 8.2 landed, the test should pass against the real tree
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `test(guard): static scan prevents legacy channel_session_id writes (Task 8.3)`
  - **Commit SHA:** ``

## TDD for 9.1 Start a daemon built from this change against an `agents` table seeded with the old schema (only `channel_session_id`, no `delivery_*`); assert it bootstraps cleanly and migrates without data loss
- kind: integration-test
- **Spec scenario(s):**
  - `agent-registry/spec.md` → Scenario: `Startup migration on old schema adds both columns`
  - `agent-registry/spec.md` → Scenario: `Startup migration backfills claude-channel rows`
- **Files:**
  - Create: `tests/e2e-backcompat-old-schema.test.ts`
- [ ] **INTEGRATION-RED:** Programmatically seed a DB at the old schema (only `channel_session_id`, no `delivery_*`), populate 2-3 rows including one with `channel_session_id='csid-abc'`; start the daemon via existing test helper; assert no error + data preserved (legacy column intact, new columns populated where expected)
- [ ] **Verify RED:** run the test against a pre-migration build; confirm failure
  - **Observed output:**
    ```
    ```
- [ ] **INTEGRATION-GREEN:** With 2.2/2.3/2.4 in place, the bootstrap should succeed against the seeded DB; no further production change expected
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `test(e2e): daemon boots against old schema without data loss (Task 9.1)`
  - **Commit SHA:** ``

## TDD for 9.2 Exercise a full Claude channel round-trip (proxy starts → subscribe_channel_wake → bind_channel → poke delivered to proxy) against the migrated DB to confirm the claude-channel path still works end-to-end
- kind: integration-test
- **Spec scenario(s):**
  - `claude-channel-transport/spec.md` → Scenario: `bind_channel updates caller's agents row when csid has live sink`
  - `agent-delivery/spec.md` → Scenario: `Route kind 'claude-channel' to ChannelWakeFanout`
- **Files:**
  - Modify: `tests/e2e-channel-poke.test.ts` (existing E2E test if present) OR create `tests/e2e-channel-poke-post-refactor.test.ts`
- [ ] **INTEGRATION-RED:** Audit the existing channel-poke E2E test; ensure it still covers the full happy path post-refactor (subscribe → bind → poke delivered); add assertions that the stored delivery is kind 'claude-channel' and that the sink is invoked exactly once
- [ ] **Verify RED:** run the test against an incomplete tree; confirm the added assertions fail where appropriate
  - **Observed output:**
    ```
    ```
- [ ] **INTEGRATION-GREEN:** With 5.x and 7.2 in place, the round-trip should pass; no further production change expected
- [ ] **Verify GREEN:** re-run the test + full suite, confirm pass
  - **Observed output:**
    ```
    ```
- [ ] **REFACTOR:** None — already minimal
- [ ] **Verify REFACTOR:** re-run tests
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `test(e2e): end-to-end Claude channel poke post-refactor (Task 9.2)`
  - **Commit SHA:** ``

## TDD for 10.1 Run `pnpm test` and confirm all suites pass
- kind: build-check
- command: `pnpm test`
- **Files:**
  - Read-only
- [ ] **IMPLEMENT:** N/A — this task verifies the full suite after all prior tasks are complete
- [ ] **BUILD-CHECK:** run `pnpm test`, confirm exit 0
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `chore(test): full suite green gate for refactor-delivery-abstraction (Task 10.1)` (empty-tree commit acceptable if tree state already matches; otherwise amend the relevant task)
  - **Commit SHA:** ``

## TDD for 10.2 Run `pnpm typecheck` and confirm no type errors
- kind: build-check
- command: `pnpm typecheck`
- **Files:**
  - Read-only
- [ ] **IMPLEMENT:** N/A — this task verifies types after all prior tasks are complete
- [ ] **BUILD-CHECK:** run `pnpm typecheck`, confirm exit 0
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `chore(typecheck): green gate for refactor-delivery-abstraction (Task 10.2)`
  - **Commit SHA:** ``

## TDD for 10.3 Run `openspec validate refactor-delivery-abstraction` and confirm it is valid
- kind: build-check
- command: `openspec validate refactor-delivery-abstraction`
- **Files:**
  - Read-only
- [ ] **IMPLEMENT:** N/A — this task verifies OpenSpec invariants after all prior tasks are complete
- [ ] **BUILD-CHECK:** run `openspec validate refactor-delivery-abstraction`, confirm it prints `Change 'refactor-delivery-abstraction' is valid` and exits 0
  - **Observed output:**
    ```
    ```
- [ ] **Commit:** `chore(openspec): validate gate for refactor-delivery-abstraction (Task 10.3)`
  - **Commit SHA:** ``

## Scenario Coverage Matrix

| Capability | Scenario | Covering task(s) |
|---|---|---|
| agent-delivery | kind 'none' has no payload | 1.1 |
| agent-delivery | kind 'claude-channel' carries channel_session_id | 1.1 |
| agent-delivery | kind 'codex-appserver' carries thread_id and ws_url | 1.1 |
| agent-delivery | Writing kind 'none' sets payload to NULL | 1.3, 1.5 |
| agent-delivery | Writing kind 'claude-channel' serializes channel_session_id into payload | 1.3, 1.5 |
| agent-delivery | Reading back a kind 'claude-channel' row reconstructs the spec | 1.2, 1.5, 3.3 |
| agent-delivery | Reading a non-'none' row with unparseable payload fails fast | 1.2, 1.5 |
| agent-delivery | Write validator accepts kind 'none' | 1.4, 1.5 |
| agent-delivery | Write validator accepts kind 'claude-channel' with valid channel_session_id | 1.4, 1.5 |
| agent-delivery | Write validator rejects kind 'codex-appserver' in this change | 1.4, 1.5, 4.5 |
| agent-delivery | Write validator rejects unknown kind | 1.4, 1.5 |
| agent-delivery | Write validator rejects kind 'claude-channel' missing channel_session_id | 1.4, 1.5 |
| agent-delivery | Route kind 'claude-channel' to ChannelWakeFanout | 7.2, 7.3, 9.2 |
| agent-delivery | Route kind 'none' to tmux when pane is set | 7.2, 7.3 |
| agent-delivery | Route kind 'none' with no tmux returns no_transport_available | 7.2, 7.3 |
| agent-delivery | kind 'codex-appserver' returns dispatcher_not_implemented in this change | 7.2, 7.3 |
| agent-delivery | derived channel_session_id for claude-channel delivery | 3.4, 3.6 |
| agent-delivery | derived channel_session_id is null for other kinds | 3.4, 3.6 |
| agent-registry | Fresh database creates agents table with delivery_kind and delivery_payload columns | 2.1, 2.5 |
| agent-registry | Startup migration on old schema adds both columns | 2.2, 2.6, 9.1 |
| agent-registry | Startup migration backfills claude-channel rows | 2.3, 2.6, 9.1 |
| agent-registry | Startup migration is idempotent | 2.2, 2.7 |
| agent-registry | Startup migration leaves channel_session_id column untouched | 2.4 |
| agent-registry | register_agent without delivery preserves existing default behavior | 4.1, 4.5 |
| agent-registry | register_agent with delivery kind 'claude-channel' persists both columns atomically | 4.3, 4.5 |
| agent-registry | register_agent with invalid delivery rejects without inserting | 4.2, 4.5 |
| agent-registry | list_agents surfaces delivery for kind 'claude-channel' | 6.1, 6.3 |
| agent-registry | list_agents surfaces delivery kind 'none' for agents with no channel | 6.1, 6.3 |
| agent-registry | Fresh database still creates agents table with channel_session_id column | 2.1, 2.5 |
| agent-registry | No write path updates the legacy column directly | 8.2, 8.3, 3.5 |
| agent-registry | list_agents surfaces derived channel_session_id for claude-channel delivery | 6.2, 6.3 |
| agent-registry | list_agents returns null channel_session_id for non-claude delivery kinds | 6.2, 6.3 |
| claude-channel-transport | bind_channel updates caller's agents row when csid has live sink | 5.1, 5.3, 9.2 |
| claude-channel-transport | bind_channel rejects unknown channel_session_id | 5.2, 5.3 |
| claude-channel-transport | bind_channel rejects proxy caller | 5.2, 5.3 |
| claude-channel-transport | bind_channel does not touch legacy channel_session_id column | 5.4 |
