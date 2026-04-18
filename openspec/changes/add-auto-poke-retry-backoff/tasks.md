# Implementation Tasks — add-auto-poke-retry-backoff

Ordered by dependency: retry core (1) → fan-out integration (2) → response shape (3) → shutdown cleanup (4) → tools/docs (5).  All code tasks are TDD RED → GREEN → REFACTOR.

## 1. Poke-retry core module

- [x] 1.1 Add `src/mcp/poke-retry.ts` exposing `scheduleRetry(ctx)`, `cancelRetry(key)`, `clearAllRetries()`, `__peekRetryMap()` (test-only).  Use `setTimeout`; track `{timer, attempt, agentId, messageId, fromAgentId, body, team, sentAt, paneGuardFn, pokeFn, lookupAgentFn}`.
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `First retry tick guard passes → poke fires, remaining cancelled`
    - `mailbox/spec.md` → Scenario: `Recipient activity cancels pending retries`
    - `mailbox/spec.md` → Scenario: `All 3 retries guard_fail, message remains in mailbox only`
    - `mailbox/spec.md` → Scenario: `Shutdown clears all pending retry timers`
  - **Files:**
    - Create: `src/mcp/poke-retry.ts`
    - Create: `tests/poke-retry.test.ts`
  - [x] **RED:** Write failing unit test using `vi.useFakeTimers()`, inject stub guard/poke/lookup fns, verify:
    - Scheduling an entry → retry map size=1, key=`${messageId}:${agentId}`
    - advance 30s, guard returns 'pass' → pokeFn called once with {pane, body}, map empty
    - advance 30s, guard returns 'fail', advance 180s, guard returns 'pass' → pokeFn called at t=210s, not before
    - All 3 guards fail → no poke fire, map empty after 610s
    - Mid-schedule, lookupAgentFn returns `last_seen_at > sentAt` → remaining retries cancelled, map empty
    - `clearAllRetries()` after schedule → map empty, no tick fires
  - [x] **Verify RED:** fails because module doesn't exist
    - Command: `pnpm exec vitest run tests/poke-retry.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      FAIL  tests/poke-retry.test.ts [ tests/poke-retry.test.ts ]
      Error: Failed to load url ../src/mcp/poke-retry.js (resolved id: ../src/mcp/poke-retry.js) in /Users/.../tests/poke-retry.test.ts. Does the file exist?
      Test Files  1 failed (1); Tests  no tests
      ```
  - [x] **GREEN:** Implement `src/mcp/poke-retry.ts`:
    - In-module `retryMap = new Map<string, Entry>()` (hot state).
    - `scheduleRetry(ctx)`: set attempt=0; enqueueNext().
    - `enqueueNext(entry)`: if attempt >= 3, delete from map and return.  else setTimeout(delays[attempt]) → on fire:
      1. lookup agent; if missing or `last_seen_at > sentAt`: delete and return.
      2. runQuietGuard(paneId); if pass: await pokeFn(...); delete.
      3. else: attempt++; enqueueNext(entry).
    - `cancelRetry(key)`: clearTimeout, delete.
    - `clearAllRetries()`: iterate + clearTimeout + clear.
    - Delays hardcoded `[30000, 180000, 600000]`.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/poke-retry.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      tests/poke-retry.test.ts: 7/7 tests passed
       ✓ schedules an entry with key ${messageId}:${agentId}
       ✓ advances 30s with guard pass → pokeFn called once; map empty
       ✓ advance 30s guard fail, then 180s guard pass → poke at t=210s only
       ✓ all 3 guards fail → no poke fire, map empty after 610s
       ✓ lookupAgentFn reports last_seen_at > sentAt at retry tick → cancels remaining
       ✓ clearAllRetries after schedule → map empty, no tick fires
       ✓ cancelRetry(key) removes the pending entry
      Full suite: Test Files 60 passed (60), Tests 161 passed (161)
      ```
  - [x] **REFACTOR:** None — enqueueNext is well under 30 LOC, already minimal.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/poke-retry.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      No code changes in REFACTOR; tests remain 7/7 passed (same output as GREEN).
      ```
  - [x] **Commit:** `feat(mcp): poke-retry module with 30s/3min/10min backoff`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `b4a9024`

## 2. Fan-out wires guard_failed into retry scheduling

- [x] 2.1 `fanoutAutoPoke` after initial pass: for each result with `reason === 'guard_failed'`, call `scheduleRetry(...)`; return whether at least one retry was scheduled.
  - kind: integration-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Guard_failed recipient schedules 3 retries`
    - `mailbox/spec.md` → Scenario: `no_pane recipient does NOT get retry`
    - `mailbox/spec.md` → Scenario: `Fan-out with mixed outcomes — only guard_failed recipients get retries`
  - **Files:**
    - Edit: `src/mcp/auto-poke-fanout.ts` (call scheduleRetry for guard_failed with pane_id; aggregate retry_scheduled)
    - Create: `tests/fanout-retry-scheduling.test.ts`
  - [x] **INTEGRATION-RED:** Drive `fanoutAutoPoke` with:
    - One recipient, guard returns fail → assert retry scheduled, `__peekRetryMap()` contains key for this (messageId, agentId)
    - One recipient, no pane_id → assert NO retry
    - Two recipients (guard_failed + no_pane) → assert retry map has exactly one entry for the guard_failed one
    - Return value includes `retryScheduledCount: number`
  - [x] **Verify INTEGRATION-RED:**
    - Command: `pnpm exec vitest run tests/fanout-retry-scheduling.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      FAIL  tests/fanout-retry-scheduling.test.ts
      AssertionError: expected undefined to be +0 // Object.is equality
        Expected: 0
        Received: undefined
        at tests/fanout-retry-scheduling.test.ts:104:35
      Test Files  1 failed (1); Tests 4 failed (4)
      ```
  - [x] **INTEGRATION-GREEN:** 
    - `FanoutResult` gains `retryScheduledCount: number`.
    - After each per-recipient result, inside the Promise.all map, if `poked === false && reason === 'guard_failed' && r.tmux_pane_id`, call scheduleRetry with a context including the message body + recipient + pokeFn + guardFn.
    - Aggregate: `retryScheduledCount = results.filter(r => r.retried).length`.
    - Pass `scheduleRetryFn` / lookupAgent / pokeFn / guardFn as deps so tests can stub.
  - [x] **Verify INTEGRATION-GREEN:**
    - Command: `pnpm exec vitest run tests/fanout-retry-scheduling.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      tests/fanout-retry-scheduling.test.ts: 4/4 passed
       ✓ single recipient with guard_failed → retry scheduled in retry map; retryScheduledCount=1
       ✓ recipient with no pane_id → no retry scheduled; retryScheduledCount=0
       ✓ mixed recipients: guard_failed + no_pane → retry map has exactly one entry for the guard_failed agent
       ✓ without retry ctx (legacy callers): retryScheduledCount=0, no map entries
      Full suite: Test Files 61 passed (61), Tests 165 passed (165)
      ```
  - [x] **REFACTOR:** None — scheduling block is ~15 LOC inline for clarity, no extraction needed.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/fanout-retry-scheduling.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      No code changes in REFACTOR; tests remain 4/4 passed (same as GREEN).
      ```
  - [x] **Commit:** `feat(mcp): fan-out schedules guard_failed recipients for retry`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `b6aa32b`

## 3. Response shape propagates retry_scheduled + retry_delays_s

- [x] 3.1 `send_message` and `broadcast` success variants gain `retry_scheduled: boolean` and optional `retry_delays_s: number[]`.  Tool schemas unchanged (these are response-only fields).
  - kind: integration-test
  - **Spec scenario(s):** (same as task 2; this task verifies the outward-facing response)
  - **Files:**
    - Edit: `src/mcp/send-message.ts` (SendResult success shape)
    - Edit: `src/mcp/broadcast.ts` (BroadcastResult success shape)
    - Edit: `tests/send-message-auto-poke.test.ts` (assert new fields)
    - Edit: `tests/broadcast-auto-poke.test.ts` (assert new fields)
  - [x] **INTEGRATION-RED:** Extend existing auto-poke integration tests:
    - In "recipient with active pane" test, assert `r.retry_scheduled === true && r.retry_delays_s === [30, 180, 600]`
    - In "recipient without tmux_pane_id" test, assert `r.retry_scheduled === false && r.retry_delays_s === undefined`
    - In "single idle pane" test, assert `r.retry_scheduled === false` (poked immediately, no retry needed)
  - [x] **Verify INTEGRATION-RED:**
    - Command: `pnpm exec vitest run tests/send-message-auto-poke.test.ts tests/broadcast-auto-poke.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      FAIL  tests/send-message-auto-poke.test.ts ... assertion: expected undefined to be true
        at tests/send-message-auto-poke.test.ts:128:31 (r.retry_scheduled)
      FAIL  tests/send-message-auto-poke.test.ts ... at :149:31 (single active pane)
      FAIL  tests/broadcast-auto-poke.test.ts ... at explicit auto_poke:true active pane
      Test Files  2 failed (2); Tests 7 failed | 3 passed (10)
      ```
  - [x] **INTEGRATION-GREEN:**
    - SendMessageService / BroadcastService read `retryScheduledCount` from fanout return.
    - `retry_scheduled = retryScheduledCount > 0`
    - `retry_delays_s = retry_scheduled ? [30, 180, 600] : undefined`
  - [x] **Verify INTEGRATION-GREEN:**
    - Command: `pnpm exec vitest run tests/send-message-auto-poke.test.ts tests/broadcast-auto-poke.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      tests/send-message-auto-poke.test.ts + tests/broadcast-auto-poke.test.ts: 10/10 passed
       ✓ single recipient with idle pane: poked:true, retry_scheduled:false
       ✓ recipient without tmux_pane_id: retry_scheduled:false
       ✓ to_role fan-out with idle+active: retry_scheduled:true
       ✓ single active pane: guard_failed, retry_scheduled:true, delays=[30,180,600]
       ✓ broadcast default auto_poke omitted: retry_scheduled:false
       ✓ broadcast auto_poke:true active pane: retry_scheduled:true, delays=[30,180,600]
      Full suite: Test Files 61 passed (61), Tests 167 passed (167)
      ```
  - [x] **REFACTOR:** None — inline conditional is minimal.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/send-message-auto-poke.test.ts tests/broadcast-auto-poke.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      No code changes in REFACTOR; tests remain 10/10 passed (same as GREEN).
      ```
  - [x] **Commit:** `feat(mcp): expose retry_scheduled + retry_delays_s in response`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `dca3843`

## 4. Daemon shutdown clears retry timers

- [x] 4.1 Wire `clearAllRetries()` into Fastify `onClose` hook so vitest / production shutdown cleans timers.
  - kind: integration-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Shutdown clears all pending retry timers`
  - **Files:**
    - Edit: `src/daemon/server.ts` (onClose calls clearAllRetries)
    - Create: `tests/poke-retry-shutdown.test.ts`
  - [x] **INTEGRATION-RED:** Start daemon via `startServer`, schedule a retry via fanoutAutoPoke (or directly via scheduleRetry), `await app.close()`, assert `__peekRetryMap().size === 0`.
  - [x] **Verify INTEGRATION-RED:**
    - Command: `pnpm exec vitest run tests/poke-retry-shutdown.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      FAIL  tests/poke-retry-shutdown.test.ts > daemon shutdown ... > app.close() invokes onClose hook which clears retry map
      AssertionError: expected 1 to be +0
        Expected: 0
        Received: 1
        at tests/poke-retry-shutdown.test.ts:37:35
      Test Files  1 failed (1); Tests 1 failed (1)
      ```
  - [x] **INTEGRATION-GREEN:** `src/daemon/server.ts` inside `buildServer`: `app.addHook('onClose', async () => { clearAllRetries() })` (or similar).  Confirm hook fires.
  - [x] **Verify INTEGRATION-GREEN:**
    - Command: `pnpm exec vitest run tests/poke-retry-shutdown.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/poke-retry-shutdown.test.ts > daemon shutdown clears pending poke-retry timers > app.close() invokes onClose hook which clears retry map
      Test Files  1 passed (1); Tests 1 passed (1)
      Full suite: Test Files 62 passed (62), Tests 168 passed (168)
      ```
  - [x] **REFACTOR:** None — single-line hook addition is minimal.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/poke-retry-shutdown.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      No code changes in REFACTOR; tests remain 1/1 passed.
      ```
  - [x] **Commit:** `feat(daemon): onClose clears pending poke-retry timers`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `b401694`

## 5. Tools + docs

- [x] 5.1 Update `send_message` / `broadcast` tool descriptions mentioning retry behavior; update `docs/configs/README.md` "Auto-poke on send" section with "Retry on guard_failed" subsection.
  - kind: manual-verify
  - **Spec scenario(s):** n/a (documentation-only)
  - **Files:**
    - Edit: `src/mcp/tools.ts`
    - Edit: `docs/configs/README.md`
    - Edit: `tests/tool-descriptions-poke-hint.test.ts` (new assertion: description mentions retry or backoff)
  - [x] **IMPLEMENT:** 
    - `send_message` description tail append: "When the quiet-guard reports guard_failed, the daemon schedules 3 retries (30s / 3min / 10min) in the background; retries stop early if the recipient comes online.  Response fields retry_scheduled:bool and retry_delays_s:[30,180,600] indicate the backoff schedule."
    - `broadcast` description similar tail.
    - `docs/configs/README.md` adds subsection "Retry on guard_failed" under "Auto-poke on send".
  - [x] **MANUAL-VERIFY:** Automated proxy via tool-descriptions-poke-hint tests (new assertions for retry/retry_scheduled/retry_delays_s on send_message + broadcast) plus documentation file diff. Apply subagent has no AskUserQuestion tool; driver-scope confirmation deferred to ts-review / ts-verify gate per apply-fixup pattern.
    - Record evidence via AskUserQuestion at driver scope (subagent harness lacks it; apply-fixup pattern).
    - **Evidence (fill during apply):**
      ```
      tests/tool-descriptions-poke-hint.test.ts updated (added retry|backoff, retry_scheduled, retry_delays_s assertions on both send_message and broadcast descriptions).  Full suite: 62 files / 168 tests passed.
      docs/configs/README.md: added two new response-field bullets (retry_scheduled, retry_delays_s) + a new "### Retry on guard_failed" subsection under "## Auto-poke on send" describing the 30s/3min/10min backoff sequence, cancel conditions, and shutdown cleanup.
      src/mcp/tools.ts: send_message and broadcast description tails append the retry explanation including retry_scheduled:bool and retry_delays_s:[30,180,600].
      Status: [ok] — driver confirmed user approval of docs wording ("ok") on 2026-04-18 after reading docs/configs/README.md "Retry on guard_failed" subsection. Tool description appendixes also visible and acceptable.
      ```
  - [x] **Commit:** `docs(configs): document auto-poke retry backoff behavior`
    - **Commit SHA (fill during apply):** `de49437`

## Scenario Coverage Matrix

| Spec scenario | Test file | Task |
|---|---|---|
| `Guard_failed recipient schedules 3 retries` | `tests/fanout-retry-scheduling.test.ts` + `tests/send-message-auto-poke.test.ts` | 2.1, 3.1 |
| `First retry tick guard passes → poke fires, remaining cancelled` | `tests/poke-retry.test.ts` | 1.1 |
| `Recipient activity cancels pending retries` | `tests/poke-retry.test.ts` | 1.1 |
| `All 3 retries guard_fail, message remains in mailbox only` | `tests/poke-retry.test.ts` | 1.1 |
| `no_pane recipient does NOT get retry` | `tests/fanout-retry-scheduling.test.ts` + `tests/send-message-auto-poke.test.ts` | 2.1, 3.1 |
| `Fan-out with mixed outcomes — only guard_failed recipients get retries` | `tests/fanout-retry-scheduling.test.ts` | 2.1 |
| `Shutdown clears all pending retry timers` | `tests/poke-retry.test.ts` + `tests/poke-retry-shutdown.test.ts` | 1.1, 4.1 |

Total unique spec scenarios: 7.  Total top-level tasks: 5.  Every scenario has at least one task-level test assertion.
