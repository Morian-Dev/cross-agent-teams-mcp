# Implementation Tasks — add-auto-poke-on-broadcast

Ordered by dependency: tests reshape (1) → default flip (2) → tool description (3) → docs (4) → manual archive-order verify (5). All code tasks are TDD RED → GREEN → REFACTOR.

## 1. Reshape broadcast auto-poke tests for default-on semantics

- [x] 1.1 Update `tests/broadcast-auto-poke.test.ts` to express the new default-on contract: rewrite "default broadcast does not poke anyone" into "default broadcast pokes every idle pane in parallel"; add a new "explicit `auto_poke:false` reverts to pure mailbox" case; keep the "explicit `auto_poke:true` with active pane → retry" case unchanged.
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Default broadcast pokes every idle pane in parallel`
    - `mailbox/spec.md` → Scenario: `Default broadcast with mixed pane states reports per-recipient skip reasons`
    - `mailbox/spec.md` → Scenario: `Explicit auto_poke:false reverts to pure mailbox delivery`
    - `mailbox/spec.md` → Scenario: `Default broadcast with active panes schedules retries identical to send_message`
  - **Files:**
    - Modify: `tests/broadcast-auto-poke.test.ts`
  - [x] **RED:** Rewrote first test to assert default pokes all three recipients; added `explicit auto_poke:false reverts to pure mailbox`; added `default broadcast with mixed pane states` (B idle, C active, D no-pane) asserting pokeCalls=[B], skip_reasons contains {C,guard_failed}+{D,no_pane}, retry_scheduled:true; kept `explicit auto_poke:true with active pane → retry`. Removed redundant explicit-true mixed-panes test.
  - [x] **Verify RED:** fails because `BroadcastService` still defaults to no-poke.
    - Command: `pnpm exec vitest run tests/broadcast-auto-poke.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      × default broadcast (auto_poke omitted) pokes every idle pane in parallel
        → expected false to be true
      ✓ explicit auto_poke:false reverts to pure mailbox delivery
      × default broadcast with mixed pane states reports per-recipient skip reasons and schedules retry for guard_failed
        → expected [] to deeply equal [ 'B' ]
      ✓ explicit auto_poke:true with active pane: guard_failed → retry_scheduled:true, delays=[30,180,600]
      Tests  2 failed | 2 passed (4)
      ```
  - [x] **GREEN:** depends on task 2.1 (default flip in `BroadcastService.broadcast`). After task 2.1 landed, all 4 tests pass.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/broadcast-auto-poke.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output:**
      ```
      ✓ default broadcast (auto_poke omitted) pokes every idle pane in parallel
      ✓ explicit auto_poke:false reverts to pure mailbox delivery
      ✓ default broadcast with mixed pane states reports per-recipient skip reasons and schedules retry for guard_failed
      ✓ explicit auto_poke:true with active pane: guard_failed → retry_scheduled:true, delays=[30,180,600]
      Test Files  1 passed (1)
      Tests  4 passed (4)
      Full suite after description update: Test Files 63 passed (63), Tests 171 passed (171).
      ```
  - [x] **REFACTOR:** Added `clearAllRetries()` in `afterEach` to prevent shared timer state between tests; removed the now-redundant third explicit-true mixed-panes test (its assertions are covered by the new default-on mixed-panes test).
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/broadcast-auto-poke.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      Test Files  1 passed (1)
      Tests  4 passed (4)
      ```

## 2. Flip default in BroadcastService

- [x] 2.1 Change `src/mcp/broadcast.ts` line 53 from `if (input.auto_poke !== true)` to `if (input.auto_poke === false)`. This makes omission resolve to the auto-poke fan-out path; only explicit `false` short-circuits to pure mailbox.
  - kind: unit-test (driven by task 1.1's RED → GREEN cycle)
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Default broadcast pokes every idle pane in parallel`
    - `mailbox/spec.md` → Scenario: `Explicit auto_poke:false reverts to pure mailbox delivery`
  - **Files:**
    - Modify: `src/mcp/broadcast.ts`
  - [x] **RED:** test from task 1.1 is already RED.
  - [x] **Verify RED:** see task 1.1's RED verify (2 failures on default-on assertions).
  - [x] **GREEN:** applied one-line condition flip at `src/mcp/broadcast.ts:53`. No other change needed — fan-out + retry wiring already existed.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/broadcast-auto-poke.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output:**
      ```
      tests/broadcast-auto-poke.test.ts: Test Files 1 passed (1), Tests 4 passed (4)
      Full suite: Test Files 63 passed (63), Tests 171 passed (171), Duration ~5.55s
      ```
  - [x] **REFACTOR:** None — single condition flip.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output:**
      ```
      Test Files  63 passed (63)
      Tests  171 passed (171)
      ```

## 3. Update broadcast MCP tool description

- [x] 3.1 Rewrite `src/mcp/tools.ts` `broadcast` tool description (lines ~204-215) to state default-on semantics: replace "Does NOT auto-poke by default (pass auto_poke:true to poke...)" with "Auto-pokes every eligible recipient by default (per-pane parallel quiet-guard); pass auto_poke:false to fall back to pure mailbox delivery". Keep the retry-backoff description.
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Broadcast tool description states default-on with opt-out`
  - **Files:**
    - Modify: `src/mcp/tools.ts`
    - Modify or create: `tests/tools-description.test.ts` (new file created)
    - Also updated: `tests/tool-descriptions-poke-hint.test.ts` (inverted the existing "does NOT auto-poke by default" assertion to match new default-on contract).
  - [x] **RED:** Created `tests/tools-description.test.ts` asserting broadcast description contains `auto-poke`, `default`, `auto_poke:false`, `quiet-guard`, and `retry`.
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/tools-description.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      × broadcast description states auto-poke default-on and documents auto_poke:false opt-out
        → expected '...Does NOT auto-poke by default...' to match /auto_poke:\s*false/i
      Test Files  1 failed (1)
      Tests  1 failed (1)
      ```
  - [x] **GREEN:** Applied the description rewrite in `tools.ts`. Final text:
    > "Broadcasts to all other agents in the team. Auto-pokes every eligible recipient by default (per-pane parallel quiet-guard checks idleness; only idle panes are poked); the message is always persisted to every recipient's mailbox regardless. Pass auto_poke:false to opt out and deliver pure mailbox without any tmux side-effect. Response includes poked and poke_skip_reasons (reasons: no_pane, guard_failed, tmux_unavailable, self), and — when guard_failed recipients are queued — retry_scheduled:bool plus retry_delays_s:[30,180,600] indicating the 3-attempt background backoff (30s / 3min / 10min); retries stop early if the recipient comes online."
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/tools-description.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output:**
      ```
      tests/tools-description.test.ts: ✓ broadcast description states auto-poke default-on and documents auto_poke:false opt-out (Tests 1 passed)
      tests/tool-descriptions-poke-hint.test.ts: 10 passed
      Full suite: Test Files 63 passed (63), Tests 171 passed (171)
      ```
  - [x] **REFACTOR:** None.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output:**
      ```
      Test Files  63 passed (63)
      Tests  171 passed (171)
      ```

## 4. Update docs/configs README

- [x] 4.1 Update `docs/configs/README.md` "Auto-poke on send" section: change broadcast row from "opt-in (default false, pass auto_poke:true)" to "opt-out (default true, pass auto_poke:false)". Reference this change.
  - kind: build-check
  - **Spec scenario(s):** N/A (docs)
  - **Files:**
    - Modify: `docs/configs/README.md`
  - [x] **RED:** N/A (docs change)
  - [x] **GREEN:** Flipped the broadcast paragraph from opt-in to opt-out; updated the downstream "send a broadcast without auto_poke:true" bullet to "send a broadcast with auto_poke:false"; removed the obsolete "or when a broadcast uses its default" clause from the poke_skip_reasons description (default now produces skip reasons).
  - [x] **Verify:**
    - Command: `grep -n "broadcast" docs/configs/README.md`
    - **Observed output:**
      ```
      9:Manual scenario (broadcast replaces human relay):
      11:2. From opencode, call `broadcast({ body: "shared context X" })`.
      39:`broadcast` is **opt-out**: it auto-pokes every eligible recipient by default (per-pane parallel quiet-guard).  Pass `auto_poke: false` to suppress the tmux side-effect and deliver pure mailbox.
      44:- `poke_skip_reasons?: Array<{ agent_id, reason }>` — entries for recipients that were not poked.  `reason` is one of `no_pane`, `guard_failed`, `tmux_unavailable`, `self`.  Absent when the caller passed `auto_poke: false`.
      60:- Successful retries are silent side effects: the sender's `send_message` / `broadcast` response has already returned, and no additional event or mailbox row is written on retry-poke success.
      77:- You are sending a `broadcast` with `auto_poke: false` but want to poke one specific recipient.
      ```
    - Manual visual check: broadcast section now reflects new default-on behavior with `auto_poke:false` opt-out; build succeeded (tsup build: ESM dist/cli.js 61.96 KB, DTS build success).

## 5. Manual-verify archive ordering

- [x] 5.1 Before archiving this change, confirm `add-auto-poke-on-send` has already been archived (its ADDED Requirements `Send-message auto-poke default with quiet-guard` and `Broadcast auto-poke is opt-in` must be present in main `mailbox/spec.md`). Otherwise this change's REMOVED operation will fail.
  - kind: manual-verify
  - **Spec scenario(s):** N/A (process gate)
  - **Files:** N/A
  - [x] **Verify:**
    - Command: `grep -c "Broadcast auto-poke is opt-in" openspec/specs/mailbox/spec.md`
    - **Expected:** 1 (Requirement present in main spec, ready to be REMOVED by this change)
    - **If 0:** STOP. Archive `add-auto-poke-on-send` first via `/ts-archive-os`, then resume archiving this change.
    - **Observed output:**
      ```
      1
      ```
    - **Status:** RESOLVED — `add-auto-poke-on-send` archived 2026-04-18 (see `openspec/changes/archive/2026-04-18-add-auto-poke-on-send/`), main spec now contains `Broadcast auto-poke is opt-in` Requirement, gate cleared.
