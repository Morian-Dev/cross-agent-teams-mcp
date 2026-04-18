# Implementation Tasks — add-auto-poke-on-send

Ordered by dependency: guard module (1) → send_message integration (2) → broadcast integration (3) → tool wiring (4) → docs (5). All code tasks are TDD RED → GREEN → REFACTOR.

## 1. Poke quiet-guard module

- [x] 1.1 Add `src/mcp/poke-guard.ts` exposing `runQuietGuard(paneId, quietMs): Promise<'pass' | 'fail'>`; resolve env `POKE_QUIET_MS` (positive int → override, else default 2000ms).
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Recipient's pane is active, guard fails, falls back to mailbox`
    - `mailbox/spec.md` → Scenario: `Invalid POKE_QUIET_MS env falls back to default`
  - **Files:**
    - Create: `src/mcp/poke-guard.ts`
    - Create: `tests/poke-guard.test.ts`
  - [x] **RED:** Write failing unit test using a spy-capable `capturePaneTail` stub
    ```ts
    import { describe, it, expect, vi } from 'vitest'
    import { runQuietGuard, __setCapturePaneTail } from '../src/mcp/poke-guard.js'

    describe('runQuietGuard', () => {
      it('returns pass when captures match (idle pane)', async () => {
        __setCapturePaneTail(async () => 'stable tail content')
        expect(await runQuietGuard('%42', 50)).toBe('pass')
      })
      it('returns fail when captures differ (active pane)', async () => {
        let n = 0
        __setCapturePaneTail(async () => `tail-${n++}`)
        expect(await runQuietGuard('%42', 50)).toBe('fail')
      })
      it('resolveQuietMs returns ENV override when valid positive int', () => {
        process.env.POKE_QUIET_MS = '100'
        expect(resolveQuietMs()).toBe(100)
      })
      it('resolveQuietMs returns default on invalid env', () => {
        process.env.POKE_QUIET_MS = 'not-a-number'
        expect(resolveQuietMs()).toBe(2000)
      })
    })
    ```
  - [x] **Verify RED:** test file doesn't compile because module doesn't exist
    - Command: `pnpm exec vitest run tests/poke-guard.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       FAIL  tests/poke-guard.test.ts [ tests/poke-guard.test.ts ]
      Error: Failed to load url ../src/mcp/poke-guard.js (resolved id: ../src/mcp/poke-guard.js) in /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec/tests/poke-guard.test.ts. Does the file exist?
       Test Files  1 failed (1)
            Tests  no tests
      ```
  - [x] **GREEN:** Implement `src/mcp/poke-guard.ts`:
    ```ts
    import { capturePaneTail as _capture } from '../daemon/tmux-cli.js'
    const DEFAULT_QUIET_MS = 2000
    let _captureImpl = _capture
    export function __setCapturePaneTail(fn: typeof _capture) { _captureImpl = fn }
    export function __resetCapturePaneTail() { _captureImpl = _capture }
    export function resolveQuietMs(opt?: number): number {
      if (typeof opt === 'number' && opt > 0) return opt
      const n = Number(process.env.POKE_QUIET_MS)
      return Number.isInteger(n) && n > 0 ? n : DEFAULT_QUIET_MS
    }
    export async function runQuietGuard(paneId: string, quietMs?: number): Promise<'pass' | 'fail'> {
      const ms = resolveQuietMs(quietMs)
      const before = await _captureImpl(paneId, 8)
      await new Promise(r => setTimeout(r, ms))
      const after = await _captureImpl(paneId, 8)
      return before === after ? 'pass' : 'fail'
    }
    ```
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/poke-guard.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      tests/poke-guard.test.ts (6 tests) 104ms
        ✓ runQuietGuard > returns pass when captures match (idle pane)
        ✓ runQuietGuard > returns fail when captures differ (active pane)
        ✓ resolveQuietMs > returns ENV override when valid positive int
        ✓ resolveQuietMs > returns default on invalid env
        ✓ resolveQuietMs > returns default when env unset
        ✓ resolveQuietMs > honors explicit positive arg over env

      Full suite: Test Files  57 passed (57), Tests  145 passed (145), Duration 4.49s
      ```
  - [x] **REFACTOR:** None anticipated (module is ~25 LOC) — none performed; module is 31 LOC with no duplication.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/poke-guard.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      No changes from GREEN phase; same 6/6 pass recorded above. REFACTOR was a no-op.
      ```
  - [x] **Commit:** `feat(mcp): add poke-guard module with 2s pane-tail idle detection`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `35f84ee`

## 2. send_message auto_poke integration

- [x] 2.1 Extend `SendMessageService.send()` to accept `auto_poke` and invoke `runQuietGuard` + `poke.ts` per recipient, in parallel; response gains `poked` and `poke_skip_reasons`.
  - kind: integration-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Single recipient, idle pane, default triggers poke`
    - `mailbox/spec.md` → Scenario: `Recipient has no tmux_pane_id`
    - `mailbox/spec.md` → Scenario: `auto_poke:false disables the behavior entirely`
    - `mailbox/spec.md` → Scenario: `to_role fan-out, parallel guards`
  - **Files:**
    - Edit: `src/mcp/send-message.ts` (add auto_poke param, async fan-out, response shape)
    - Create: `tests/send-message-auto-poke.test.ts`
  - [x] **INTEGRATION-RED:** Write failing test driving the service directly (bypass HTTP layer), stubbing `poke-guard` + `poke.ts` to assert:
    - single recipient idle-pane → poked:true, no skip reasons
    - recipient without tmux_pane_id → poked:false, reason no_pane
    - auto_poke:false → poked:false, no skip reasons array
    - to_role with 2 recipients (one idle, one active) → poked:true, one guard_failed
    - plus self-target edge case → reason 'self'
  - [x] **Verify INTEGRATION-RED:** failures because service doesn't know about auto_poke
    - Command: `pnpm exec vitest run tests/send-message-auto-poke.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      FAIL  tests/send-message-auto-poke.test.ts (5 tests)
      Error example: expected undefined to be false (r.poked undefined)
      Error example: expected undefined to be true
      Test Files  1 failed (1)
      Tests  5 failed (5)
      Types AutoPokeFn / AutoPokeSkipReason not exported yet; SendMessageService.send is still sync; response lacks poked/poke_skip_reasons.
      ```
  - [x] **INTEGRATION-GREEN:** Update `src/mcp/send-message.ts`:
    - `SendInput` gains `auto_poke?: boolean`.
    - `SendResult` success variant gains `poked: boolean` + `poke_skip_reasons?: Array<...>`.
    - `send()` becomes `async`; after `insert(...)`, if `auto_poke !== false` (i.e. omitted or true), call a new private `fanoutPoke(team, from, recipients)` that maps each recipient to a Promise resolving to `{ poked: bool, skip?: { agent_id, reason } }`; `Promise.all`; aggregate.
    - `fanoutPoke` needs a ref to the caller's `PokeDeps`; pass via constructor (or new arg).  Keep it dependency-injected so tests can stub.
    - Also updated dependent tests (`send-message-direct`, `send-role-broadcast`, `offline-delivery`, `get-inbox`) to `await` and pass `auto_poke:false` to preserve pre-existing semantics.
  - [x] **Verify INTEGRATION-GREEN:**
    - Command: `pnpm exec vitest run tests/send-message-auto-poke.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      tests/send-message-auto-poke.test.ts (5 tests) 249ms
        ✓ single recipient with idle pane: poked:true, no skip_reasons
        ✓ recipient without tmux_pane_id: poked:false, reason no_pane
        ✓ auto_poke:false disables the behavior, no skip_reasons
        ✓ to_role fan-out with one idle + one active: poked:true + guard_failed for active
        ✓ self as sole recipient is marked self (defensive)

      Full suite (POKE_QUIET_MS=100): Test Files  58 passed (58), Tests  150 passed (150), Duration 4.89s
      ```
  - [x] **REFACTOR:** Extract `fanoutPoke` helper if >30 LOC; otherwise inline.
      - fanoutPoke is ~38 LOC but tightly coupled to SendMessageService state; kept as a private method. Task 3 will lift to `src/mcp/auto-poke-fanout.ts` if it needs to be shared.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/send-message-auto-poke.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      No refactor applied in this task; 5/5 pass unchanged.
      ```
  - [x] **Commit:** `feat(mcp): send_message auto_poke with quiet-guard fan-out`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `83cd9ce`

## 3. broadcast auto_poke opt-in integration

- [x] 3.1 Extend `BroadcastService.broadcast()` similarly (default `false`), wiring the same fan-out helper.
  - kind: integration-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Default broadcast does not poke anyone`
    - `mailbox/spec.md` → Scenario: `Explicit broadcast auto_poke:true pokes every eligible pane`
  - **Files:**
    - Edit: `src/mcp/broadcast.ts`
    - Create: `tests/broadcast-auto-poke.test.ts`
  - [x] **INTEGRATION-RED:** Test:
    - default broadcast (auto_poke omitted) → poked:false, no skip_reasons, no pane injection.
    - explicit `auto_poke: true` with 3 recipients (2 idle pane_id, 1 no pane_id) → poked:true, skip_reasons contains only the no-pane one.
  - [x] **Verify INTEGRATION-RED:**
    - Command: `pnpm exec vitest run tests/broadcast-auto-poke.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      FAIL  tests/broadcast-auto-poke.test.ts (2 tests)
      AssertionError: expected undefined to be false (default case: r.poked undefined)
      AssertionError: expected undefined to be true (opt-in case: r.poked undefined)
      Test Files  1 failed (1)
      Tests  2 failed (2)
      broadcast() still sync and lacks auto_poke/poked/poke_skip_reasons.
      ```
  - [x] **INTEGRATION-GREEN:**
    - `broadcast()` signature gains `auto_poke?: boolean` (omitted → default false).
    - Response gains `poked` + `poke_skip_reasons`.
    - When `auto_poke === true`, reuse the same `fanoutPoke` helper from task 2 (may require lifting it to a shared module, e.g. `src/mcp/auto-poke-fanout.ts`).
    - Lifted the helper into `src/mcp/auto-poke-fanout.ts`; both send-message and broadcast now import `fanoutAutoPoke` (see REFACTOR).
  - [x] **Verify INTEGRATION-GREEN:**
    - Command: `pnpm exec vitest run tests/broadcast-auto-poke.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      tests/broadcast-auto-poke.test.ts (2 tests) 146ms
        ✓ default broadcast (auto_poke omitted) does not poke anyone, no skip_reasons
        ✓ explicit auto_poke:true with mixed panes: pokes idle ones, skip_reasons lists only no_pane/guard_failed

      Full suite (POKE_QUIET_MS=100): Test Files  59 passed (59), Tests  152 passed (152), Duration 5.08s
      ```
  - [x] **REFACTOR:** If task 2 inlined `fanoutPoke` but task 3 reuses it → lift to `src/mcp/auto-poke-fanout.ts`.
      - Lifted to `src/mcp/auto-poke-fanout.ts`. `send-message.ts` now re-exports `AutoPokeFn`/`AutoPokeSkipReason` for backward compat and delegates via `fanoutAutoPoke(...)`.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/broadcast-auto-poke.test.ts tests/send-message-auto-poke.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      Test Files  2 passed (2)
      Tests  7 passed (7)
      send-message-auto-poke 5/5 + broadcast-auto-poke 2/2; REFACTOR kept green.
      ```
  - [x] **Commit:** `feat(mcp): broadcast auto_poke opt-in with shared guard fan-out`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `d0e3ad7`

## 4. Tools wire-up & descriptions

- [x] 4.1 Expose `auto_poke` in `send_message` / `broadcast` tool schemas; update their descriptions; add regression assertions.
  - kind: integration-test
  - **Spec scenario(s):** (tool-layer; no new spec scenarios; delegates to requirements already covered by tasks 2 & 3)
  - **Files:**
    - Edit: `src/mcp/tools.ts` (inputSchema + description rewrite)
    - Edit: `tests/tool-descriptions-poke-hint.test.ts` (update existing `send_message`/`broadcast` description assertions to reflect new defaults; add assertions for `auto_poke` schema presence)
  - [x] **INTEGRATION-RED:** Rewrite two existing test cases to expect the new description language ("by default this tool pokes the recipient after a quiet-guard", "broadcast does NOT auto-poke unless auto_poke:true"); add one new case asserting the tool input schema contains an `auto_poke` field of type boolean.
  - [x] **Verify INTEGRATION-RED:**
    - Command: `pnpm exec vitest run tests/tool-descriptions-poke-hint.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      FAIL  send_message description mentions auto-poke default + quiet-guard
        expected description to match /by default|default/i (old text still there)
      FAIL  broadcast description states does NOT auto-poke by default
        expected description to match /not auto-poke|.../ (old description lacks new wording)
      FAIL  send_message and broadcast tool schemas expose auto_poke as optional boolean
        expected undefined to be 'boolean' (schema missing auto_poke prop)
      Test Files  1 failed (1)
      Tests  3 failed | 6 passed (9)
      ```
  - [x] **INTEGRATION-GREEN:** Update `src/mcp/tools.ts`:
    - `send_message` inputSchema: `auto_poke: z.boolean().optional()`.  Description becomes: "Sends a direct or role-broadcast message.  By default the tool also wakes the recipient's tmux pane via a quiet-guard poke (auto_poke=true); pass auto_poke:false if the recipient should only see it on their next get_inbox.  The response reports poked:true/false and, when applicable, poke_skip_reasons per recipient."
    - `broadcast` inputSchema: `auto_poke: z.boolean().optional()`.  Description becomes: "Broadcasts to all other agents in the team.  Does NOT auto-poke by default (use auto_poke:true to poke every eligible pane after a per-pane quiet-guard).  Response includes poked and poke_skip_reasons."
    - Also wired a real `AutoPokeFn` (calling existing `poke()`) into both services via constructor deps, mapping downstream poke errors to skip reasons (`tmux_unavailable`, `tmux_pane_not_set` → `no_pane`, `self_poke_denied` → `self`, else `guard_failed`).
  - [x] **Verify INTEGRATION-GREEN:**
    - Command: `pnpm exec vitest run tests/tool-descriptions-poke-hint.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      tests/tool-descriptions-poke-hint.test.ts (9 tests) 120ms
        ✓ send_message description mentions auto-poke default + quiet-guard
        ✓ broadcast description states does NOT auto-poke by default and explains opt-in
        ✓ send_message and broadcast tool schemas expose auto_poke as optional boolean
        ✓ task_add description mentions poke for nudging a specific agent
        ✓ get_inbox description does NOT recommend poke
        ✓ poke tool description remains (sanity)
        ✓ register_agent description demands a pre-call tmux check (imperative)
        ✓ register_agent description prefers $TMUX_PANE over tmux display-message
        ✓ register_agent description instructs how to handle both branches

      Full suite (POKE_QUIET_MS=100): Test Files  59 passed (59), Tests  153 passed (153), Duration 5.05s
      ```
  - [x] **REFACTOR:** None.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/tool-descriptions-poke-hint.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      No refactor applied; 9/9 pass unchanged.
      ```
  - [x] **Commit:** `feat(mcp): wire auto_poke into send_message + broadcast tool schemas`
    - Staging order: test file BEFORE production file
    - **Commit SHA (fill during apply):** `55bc567`

## 5. Docs: Auto-poke on send

- [x] 5.1 Update `docs/configs/README.md` — add "Auto-poke on send" section, mark old "send + poke idiom" obsolete.
  - kind: manual-verify
  - **Spec scenario(s):** n/a (documentation-only)
  - **Files:**
    - Edit: `docs/configs/README.md`
  - [x] **IMPLEMENT:** Append or integrate:
    - New section "Auto-poke on send": default on for `to_agent_id` + `to_role`, default off for `broadcast`, guard 2s `POKE_QUIET_MS` env, response fields `poked` + `poke_skip_reasons`.
    - Edit or strike through the existing "send + poke idiom" section, replacing with a pointer to "Auto-poke on send".
  - [x] **MANUAL-VERIFY:** user reads and confirms wording + placement
    - Record evidence via AskUserQuestion at driver scope (subagent harness lacks it; apply-fixup pattern)
    - **Evidence (fill during apply):**
      ```
      Confirmed by user at driver scope 2026-04-18. User reviewed the appended "Auto-poke on send" section in docs/configs/README.md (includes default on for to_agent_id + to_role, default off for broadcast, POKE_QUIET_MS env with fallback, response fields poked + poke_skip_reasons, tuning examples, and obsolete-idiom subsection) and approved wording + placement ("ok") without requested changes.
      ```
  - [x] **Commit:** `docs(configs): document auto-poke-on-send default behavior and quiet-guard`
    - **Commit SHA (fill during apply):** `7c93101`

## Scenario Coverage Matrix

| Spec scenario | Test file | Task |
|---|---|---|
| `Single recipient, idle pane, default triggers poke` | `tests/send-message-auto-poke.test.ts` | 2.1 |
| `Recipient's pane is active, guard fails, falls back to mailbox` | `tests/poke-guard.test.ts` + `tests/send-message-auto-poke.test.ts` | 1.1, 2.1 |
| `Recipient has no tmux_pane_id` | `tests/send-message-auto-poke.test.ts` | 2.1 |
| `auto_poke:false disables the behavior entirely` | `tests/send-message-auto-poke.test.ts` | 2.1 |
| `to_role fan-out, parallel guards` | `tests/send-message-auto-poke.test.ts` | 2.1 |
| `Invalid POKE_QUIET_MS env falls back to default` | `tests/poke-guard.test.ts` | 1.1 |
| `Default broadcast does not poke anyone` | `tests/broadcast-auto-poke.test.ts` | 3.1 |
| `Explicit broadcast auto_poke:true pokes every eligible pane` | `tests/broadcast-auto-poke.test.ts` | 3.1 |

Total unique spec scenarios: 8. Total top-level tasks: 5.  Every scenario has at least one task-level test assertion.
