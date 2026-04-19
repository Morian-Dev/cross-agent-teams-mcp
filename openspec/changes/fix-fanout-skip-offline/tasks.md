# Implementation Tasks — fix-fanout-skip-offline

Ordered by dependency: export ONLINE_MS (1) → broadcast filter (2) → send_message to_role filter (3) → tool descriptions + docs (4). Tasks 2/3 each drive their own TDD cycle; shared online-filter scenarios tested via a single new file that covers both.

## 1. Export ONLINE_MS constant

- [x] 1.1 Convert `ONLINE_MS` in `src/storage/agents-repo.ts` from a file-scope const (currently not exported) into a named `export const`. Keep the value `5 * 60 * 1000` unchanged. `AgentsRepo.list()` should keep using it (refactor to read the exported symbol).
  - kind: unit-test
  - **Spec scenario(s):** N/A (refactor enabling; tested indirectly via tasks 2 and 3)
  - **Files:**
    - Modify: `src/storage/agents-repo.ts`
  - [x] **RED:** Not applicable — pure refactor export. Skip explicit RED; add a trivial unit test `tests/online-threshold.test.ts` that imports `{ ONLINE_MS }` and asserts `ONLINE_MS === 300000`. This will fail if the export is missing (import error) or the value changes.
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/online-threshold.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      × tests/online-threshold.test.ts > ONLINE_MS export > is exported and equals 5 minutes in ms
        → expected undefined to be 300000 // Object.is equality
      Test Files  1 failed (1)
      Tests  1 failed (1)
      ```
  - [x] **GREEN:** Add `export` to the const; no other change.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/online-threshold.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/online-threshold.test.ts > ONLINE_MS export > is exported and equals 5 minutes in ms
      Test Files  1 passed (1) / Tests  1 passed (1)
      Full suite: Test Files  65 passed (65) / Tests  180 passed (180)
      ```
  - [x] **REFACTOR:** None.
  - [x] **Verify REFACTOR:** (noop verify with the same command as GREEN)
    - **Observed output (fill during apply):**
      ```
      No refactor performed; GREEN result stands (180 passing).
      ```

## 2. Broadcast: filter offline recipients

- [x] 2.1 Modify `src/mcp/broadcast.ts` recipient SELECT to include `AND last_seen_at > ?` with cutoff = `new Date(Date.now() - ONLINE_MS).toISOString()`.
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Broadcast skips offline recipients in fan-out`
    - `mailbox/spec.md` → Scenario: `Broadcast with no online recipients besides sender returns unknown_recipient`
    - `mailbox/spec.md` → Scenario: `list_agents still returns offline ghosts for diagnosis` (verify list_agents unaffected in same suite)
  - **Files:**
    - Modify: `src/mcp/broadcast.ts`
    - Create: `tests/fanout-skip-offline.test.ts` (shared with task 3.1)
  - [x] **RED:** In `tests/fanout-skip-offline.test.ts` added 3 broadcast-side cases (plus 3 send_message cases for task 3.1 in the same file).
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/fanout-skip-offline.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      FAIL tests/fanout-skip-offline.test.ts > broadcast skips offline > excludes agents with last_seen_at older than ONLINE_MS
        AssertionError: expected [ 'B','C','D' ] to deeply equal [ 'B','D' ]
      FAIL tests/fanout-skip-offline.test.ts > broadcast skips offline > returns unknown_recipient when all non-sender agents are offline
        AssertionError: expected success result to deeply equal { error: 'unknown_recipient' }
      FAIL send_message to_role: 2 cases
      PASS list_agents ghosts case + to_agent_id offline bypass case
      Tests  4 failed | 3 passed (7)
      ```
  - [x] **GREEN:** Imported `ONLINE_MS` from `../storage/agents-repo.js`; added `AND last_seen_at > ?` with cutoff param.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/fanout-skip-offline.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      ✓ broadcast skips offline > excludes agents with last_seen_at older than ONLINE_MS
      ✓ broadcast skips offline > returns unknown_recipient when all non-sender agents are offline
      ✓ broadcast skips offline > list_agents still shows offline ghosts
      Test Files  1 passed / Tests  7 passed (7)
      Full suite: Test Files 66 passed / Tests 187 passed (187)
      ```
  - [x] **REFACTOR:** Considered extracting `onlineCutoffIso()` helper; decided to keep the two inline call-sites (one line each) for clarity — no duplication worth abstracting per YAGNI.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      No code change in refactor; GREEN suite result stands (187 passing).
      ```

## 3. send_message to_role: filter offline; to_agent_id unaffected

- [x] 3.1 Modify `src/mcp/send-message.ts` to_role branch (current line ~65) to include `AND last_seen_at > ?`. The `to_agent_id` branch (line ~59) MUST remain unchanged.
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `send_message to_role excludes offline agents`
    - `mailbox/spec.md` → Scenario: `send_message to_agent_id unaffected by online filter`
    - `mailbox/spec.md` → Scenario: `to_role with all-offline matches returns unknown_recipient`
  - **Files:**
    - Modify: `src/mcp/send-message.ts`
    - Modify (extend): `tests/fanout-skip-offline.test.ts` — added 3 `send_message` cases (mixed online/offline, all-offline, offline-direct still delivers).
  - [x] **RED:** Added to_role mixed, to_role all-offline, and to_agent_id offline cases (co-located in the shared file added in task 2.1).
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/fanout-skip-offline.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      FAIL send_message > to_role with mixed online/offline > expected [F1,F3] got [F1,F2,F3]
      FAIL send_message > to_role with all-offline > expected {error:'unknown_recipient'} got success
      PASS send_message > to_agent_id ignores online state (still delivers)
      (co-reported with task 2.1 RED: 4 failed | 3 passed of 7 total)
      ```
  - [x] **GREEN:** Imported `ONLINE_MS`; applied `AND last_seen_at > ?` to to_role branch only; to_agent_id SELECT at line 59-60 untouched.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/fanout-skip-offline.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      ✓ send_message to_role skips offline > to_role with mixed online/offline yields only online recipients
      ✓ send_message to_role skips offline > to_role with all-offline matches returns unknown_recipient
      ✓ send_message to_role skips offline > to_agent_id ignores online state (offline target still gets mailbox row)
      Test Files 1 passed / Tests 7 passed (7)
      Full suite: 66 files / 187 tests passed
      ```
  - [x] **REFACTOR:** Deferred per task 2.1 decision — no helper extracted.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      No refactor performed; full suite remains 187 passing.
      ```

## 4. Tool description + docs

- [x] 4.1 Update `src/mcp/tools.ts` `send_message` and `broadcast` descriptions to document the online-filter behavior. Extend `tests/tool-descriptions-poke-hint.test.ts` with 2 new assertions.
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `MCP tool descriptions document the fan-out online filter`
  - **Files:**
    - Modify: `src/mcp/tools.ts`
    - Modify: `tests/tool-descriptions-poke-hint.test.ts`
  - [x] **RED:** Added 2 new tests at end of file: send_message must match `/offline|5 min|idle/i` AND `/to_agent_id/i`; broadcast must match `/offline|5 min|idle/i`.
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/tool-descriptions-poke-hint.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      FAIL tool descriptions > send_message description documents the fan-out online filter and to_agent_id exception
        AssertionError: expected send_message description to match /to_agent_id/i
      PASS broadcast description documents the fan-out online filter
        (pre-existing description already contained "idle")
      Tests 1 failed | 13 passed (14)
      ```
  - [x] **GREEN:** Appended online-filter sentences to send_message and broadcast tool descriptions; send_message now names `to_agent_id` and `5 min` idle threshold explicitly; broadcast mentions the 5 min idle rule.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/tool-descriptions-poke-hint.test.ts --reporter=verbose`
    - Full-suite: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      ✓ send_message description documents the fan-out online filter and to_agent_id exception
      ✓ broadcast description documents the fan-out online filter
      Tests 14 passed (14)
      Full suite: 66 files / 189 tests passed
      ```
  - [x] **REFACTOR:** None.
  - [x] **Verify REFACTOR:** (same as GREEN)
    - **Observed output (fill during apply):**
      ```
      No refactor; GREEN result stands (189 passing).
      ```

- [x] 4.2 Update `docs/configs/README.md` to note the new fan-out online filter behavior (in the auto-poke or a new short subsection), stating: "Role-based routing and broadcast skip agents whose `last_seen_at` is > 5 min old. Direct `to_agent_id` is not filtered. Consistent with the 5-min `ONLINE_MS` threshold used by `list_agents` for the `online` flag."
  - kind: build-check
  - **Files:**
    - Modify: `docs/configs/README.md`
  - [x] **GREEN:** Added `### Fan-out online filter` subsection under the auto-poke section documenting to_role/broadcast skip + to_agent_id exception + ONLINE_MS reference.
  - [x] **Verify:**
    - Command: `grep -c "5 min\|ONLINE_MS\|online filter\|offline" docs/configs/README.md`
    - **Expected:** ≥ 1 (at least one of the markers present)
    - **Observed output (fill during apply):**
      ```
      3
      ```

- [x] 4.3 Runtime build sanity: `pnpm run build` succeeds and dist/cli.js contains the new SELECT fragment (e.g. `last_seen_at >`).
  - kind: build-check
  - **Files:** N/A
  - [x] **Verify:**
    - Command: `pnpm run build && grep -c "last_seen_at >" dist/cli.js`
    - **Expected:** Exit 0 and grep count ≥ 2 (broadcast + send-message each appear at least once)
    - **Observed output (fill during apply):**
      ```
      pnpm run build: ESM dist/cli.js 63.63 KB — Build success in 12ms; DTS Build success in 706ms
      grep -c "last_seen_at >" dist/cli.js = 3
      ```
