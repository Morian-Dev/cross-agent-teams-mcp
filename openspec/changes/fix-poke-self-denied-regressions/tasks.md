# Tasks

## 1. Locate root cause and repair test fixtures

- [x] 1.1 Capture baseline failure on `tests/poke-validation.test.ts` (RED witness)
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `Target never registered pane id` (existing main spec, regression-preserving)
  - **Files:**
    - Modify: `tests/poke-validation.test.ts`
    - Modify: `src/mcp/poke.ts` (read-only verification — no edit; production guard already correct, see design D1)
  - **RED:** Existing assertion at `tests/poke-validation.test.ts:94` (`expect(obj).toEqual({ error: 'tmux_pane_not_set' })`) currently fails because both `register` calls land on the same `agents` row under `(team='default', name='tester-8')` and `target.agent_id === callerAgentId` triggers `self_poke_denied`.
    - Behavior under test: caller A and target B are two distinct MCP clients; target registered without `tmux_pane_id`; the poke MUST return `{ error: 'tmux_pane_not_set' }` because they are distinct agents and the target lacks a pane.
    - Expected failure reason: `(default, tester-8)` upserts collapse A's and B's registrations onto one row; subsequent `poke({target_agent_id: B's_id})` resolves to A's own `agent_id`, hitting `self_poke_denied` at `src/mcp/poke.ts:124`.
  - **Verify RED:** Run failing test, observe `self_poke_denied` instead of `tmux_pane_not_set`.
    - Command: `npx vitest run tests/poke-validation.test.ts -t "tmux_pane_not_set when target has no tmux_pane_id"`
    - **Observed output (fill during apply):**
      ```
      × poke validation > returns tmux_pane_not_set when target has no tmux_pane_id 59ms
        → expected { error: 'self_poke_denied' } to deeply equal { error: 'tmux_pane_not_set' }
      AssertionError: expected { error: 'self_poke_denied' } to deeply equal { error: 'tmux_pane_not_set' }
      Test Files  1 failed (1)
           Tests  1 failed | 5 skipped (6)
      ```
  - **GREEN:** Modify `tests/poke-validation.test.ts` only:
    - Update the local `register` helper signature to accept `name?: string` so each client can register under a distinct logical identity.
    - Failing test at line 84 (`returns tmux_pane_not_set ...`): pass `name: 'tester-8-caller'` for A and `name: 'tester-8-target'` for B.
    - Other tests in this file that already share a single client MUST keep current behavior (omit `name` ⇒ default).
    - Do NOT touch `src/mcp/poke.ts` or any other production file (design D1).
    - Apply-phase note: once caller and target became distinct agents, production path routed through `dispatchPoke` and returned `no_transport_available` (the canonical channel-transport-era error), not the legacy `tmux_pane_not_set` this test originally asserted. Per D1 (forbid touching production), the assertion was updated to `{ error: 'no_transport_available', detail: { channel_subscribed: false, tmux_pane_set: false } }` — matching the behavior already pinned in `tests/poke-channel-transport.test.ts:48-65` and `tests/transport-dispatch.test.ts`.
  - **Verify GREEN:** Targeted re-run.
    - Command: `npx vitest run tests/poke-validation.test.ts`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/poke-validation.test.ts (6 tests) 121ms
      Test Files  1 passed (1)
           Tests  6 passed (6)
      ```
  - **REFACTOR:** None. Fixture diff is minimal (helper signature + two args at one call site + assertion adjusted to current canonical error).
  - **Verify REFACTOR:** Re-run targeted file.
    - Command: `npx vitest run tests/poke-validation.test.ts`
    - **Observed output (fill during apply):** `Test Files 1 passed (1); Tests 6 passed (6)`.
  - **Commit:** `test(poke-validation): use distinct names so caller and target are distinct agents`
    - Staging order: only test file (no production change in this task)
    - **Commit SHA (fill during apply):** 57e94d5

- [x] 1.2 Repair `tests/poke-tmux-unavailable.test.ts` fixture
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `No tmux binary on PATH` (existing main spec, regression-preserving)
  - **Files:**
    - Modify: `tests/poke-tmux-unavailable.test.ts`
    - Modify: `src/mcp/poke.ts` (read-only verification — no edit)
  - **RED:** Existing assertion at `tests/poke-tmux-unavailable.test.ts:54` (`expect(obj.error).toBe('tmux_unavailable')`) currently fails for the same identity-collapse reason as Task 1.1.
    - Behavior under test: when `_setTmuxAvailableForTest(false)`, A pokes B and the response MUST be `{error:'tmux_unavailable', detail:string}`.
    - Expected failure reason: A and B share `(default, tester-7)` ⇒ same `agent_id` ⇒ `self_poke_denied` short-circuit before reaching the tmux availability probe.
  - **Verify RED:** Run failing test.
    - Command: `npx vitest run tests/poke-tmux-unavailable.test.ts`
    - **Observed output (fill during apply):**
      ```
      × poke tmux_unavailable > returns tmux_unavailable when tmux binary is not available 49ms
        → expected 'self_poke_denied' to be 'tmux_unavailable' // Object.is equality
      AssertionError: expected 'self_poke_denied' to be 'tmux_unavailable'
      Expected: "tmux_unavailable"
      Received: "self_poke_denied"
      Test Files  1 failed (1)
           Tests  1 failed (1)
      ```
  - **GREEN:** Modify `tests/poke-tmux-unavailable.test.ts` only — extend its local `register` helper with `name?: string`, then in the test body pass `name: 'tester-7-caller'` for A and `name: 'tester-7-target'` for B.
  - **Verify GREEN:** Targeted re-run.
    - Command: `npx vitest run tests/poke-tmux-unavailable.test.ts`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/poke-tmux-unavailable.test.ts (1 test) 50ms
      Test Files  1 passed (1)
           Tests  1 passed (1)
      ```
  - **REFACTOR:** None.
  - **Verify REFACTOR:** Re-run targeted file.
    - Command: `npx vitest run tests/poke-tmux-unavailable.test.ts`
    - **Observed output (fill during apply):** `Test Files 1 passed (1); Tests 1 passed (1)`.
  - **Commit:** `test(poke-tmux-unavailable): use distinct names so caller and target are distinct agents`
    - Staging order: only test file
    - **Commit SHA (fill during apply):** c6d8696

- [x] 1.3 Repair `tests/poke-e2e.test.ts` fixtures (both pane_dead and happy-path scenarios)
  - kind: integration-test
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `Target pane was killed after registration` (existing main spec, regression-preserving)
    - `agent-interrupts/spec.md` → Scenario: `Happy path returns before/after tails` (existing main spec, regression-preserving)
  - **Files:**
    - Modify: `tests/poke-e2e.test.ts`
    - Modify: `src/mcp/poke.ts` (read-only verification — no edit)
  - **INTEGRATION-RED:** Both tests at lines 43 and 78 currently fail for the same identity-collapse reason; they exercise real tmux through the full daemon + MCP transport, hence integration-test kind.
    - Test 1 (`pane_dead ...`): A and B both register as `name='tester-6'` ⇒ `target.agent_id === callerAgentId` ⇒ `self_poke_denied`, never reaches the tmux pane lookup.
    - Test 2 (`happy path ...`): same identity collapse; `obj.ok` is undefined and the assertion `expect(obj.ok).toBe(true)` fails.
    - Command: `npx vitest run tests/poke-e2e.test.ts` (skip-on-no-tmux is hardwired; run on a tmux-available host to observe genuine failure)
    - **Observed output (fill during apply):**
      ```
      × poke e2e (real tmux) > returns pane_dead when target pane was killed after registration 288ms
        → expected 'self_poke_denied' to be 'pane_dead'
      × poke e2e (real tmux) > happy path: poke returns before/after tails for live pane 162ms
        → expected undefined to be true
      Test Files  1 failed (1)
           Tests  2 failed (2)
      ```
  - **INTEGRATION-GREEN:** Modify `tests/poke-e2e.test.ts` only — extend its `register` helper with `name?: string` and update both test bodies:
    - `pane_dead` test (line 43): `register(A.c, { name: 'tester-6-caller', role: 'caller' })` and `register(B.c, { name: 'tester-6-target', role: 'target', tmux_pane_id: paneId })`.
    - `happy path` test (line 78): same name split, plus the existing `tmux_pane_id: paneId` for B.
    - Command: `npx vitest run tests/poke-e2e.test.ts`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/poke-e2e.test.ts (2 tests) 1425ms
        ✓ poke e2e (real tmux) > happy path: poke returns before/after tails for live pane 1165ms
      Test Files  1 passed (1)
           Tests  2 passed (2)
      ```
  - **REFACTOR:** None — fixture diff is two `name:` props per test plus a 1-line helper signature widen.
  - **Verify REFACTOR:** Re-run.
    - Command: `npx vitest run tests/poke-e2e.test.ts`
    - **Observed output (fill during apply):** `Test Files 1 passed (1); Tests 2 passed (2)` on a tmux-available host (tmux 3.6a).
  - **Commit:** `test(poke-e2e): use distinct names so caller and target are distinct agents`
    - Staging order: only test file
    - **Commit SHA (fill during apply):** 48b0727

## 2. Reverse-regression test pinning the canonical guard semantics

- [x] 2.1 Add `tests/poke-self-denied-distinct-agents.test.ts` (unit-level, A→B with distinct `agent_id` MUST NOT be self-poke)
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `Distinct agents are never treated as self-poke` (NEW, added by this change's delta)
  - **Files:**
    - Create: `tests/poke-self-denied-distinct-agents.test.ts`
    - Modify: `src/mcp/poke.ts` (read-only verification — no edit; this test pins the existing correct guard so it cannot regress)
  - **RED:** Write the new test file. Initial RED is constructed by a deliberately-bad assertion (or by temporarily flipping the guard hypothesis described in the original task description) so we observe a real failure before pinning the correct behavior.
    - Approach: write the test with the assertion `expect(res).not.toMatchObject({ error: 'self_poke_denied' })` directly against the real `poke()` function with two seeded `agents` rows that share `tmux_pane_id` and `team` but differ in `agent_id` and `name`. Before adding the test, **apply a 1-line scratch hypothesis edit** to `src/mcp/poke.ts` line 124 changing `target.agent_id === deps.callerAgentId` to `target.tmux_pane_id === <caller's pane>` (the false hypothesis from the prompt) — vitest then RED with `self_poke_denied`. Revert the scratch edit immediately to GREEN. The test stays as a tripwire.
    - Behavior under test: three sub-cases per design D4:
      1. fully independent agents (different `team` impossible because `cross_team_denied` would fire; use same team, different name, different pane) → `ok:true` (with vi.mock'd tmux-cli)
      2. different name, **same** `tmux_pane_id` (collision on a non-identity attribute) → `ok:true` (proves the guard does not key on pane id)
      3. different name, both with `tmux_pane_id=null` → `tmux_pane_not_set` (proves the flow passes through the self-poke guard and hits the next guard, conclusively NOT self-poke)
    - Expected failure reason (during the scratch-hypothesis RED step): with the scratch guard keyed on pane id, sub-case 2 returns `self_poke_denied` because both rows share `%42`.
  - **Verify RED:** Run the new test against the scratch-hypothesis production file.
    - Command: `npx vitest run tests/poke-self-denied-distinct-agents.test.ts`
    - **Observed output (fill during apply):**
      ```
      × poke() distinct agents are never self-poke > different name but colliding tmux_pane_id are not self-poke 5ms
        → expected { error: 'self_poke_denied' } to not match object { error: 'self_poke_denied' }
      AssertionError: expected { error: 'self_poke_denied' } to not match object { error: 'self_poke_denied' }
      Test Files  1 failed (1)
           Tests  1 failed | 2 passed (3)
      ```
  - **GREEN:** Revert the scratch hypothesis edit to `src/mcp/poke.ts` (restore the canonical `target.agent_id === deps.callerAgentId` line). The test now PASSES against the correct guard.
  - **Verify GREEN:** Re-run the targeted file plus the four previously-failing files from Task 1 (regression check).
    - Command: `npx vitest run tests/poke-self-denied-distinct-agents.test.ts tests/poke-validation.test.ts tests/poke-tmux-unavailable.test.ts tests/poke-e2e.test.ts`
    - **Observed output (fill during apply):**
      ```
      ✓ tests/poke-validation.test.ts (6 tests) 100ms
      ✓ tests/poke-e2e.test.ts (2 tests) 1420ms
      ✓ tests/poke-self-denied-distinct-agents.test.ts (3 tests) 1610ms
      ✓ tests/poke-tmux-unavailable.test.ts (1 test) 9ms
      Test Files  4 passed (4)
           Tests  12 passed (12)
      ```
      `git diff src/mcp/poke.ts` ⇒ empty (revert clean).
  - **REFACTOR:** Add a 1-line top-of-file English comment in the new test file: "Tripwire: pins canonical self-poke semantics keyed on agent_id; do not relax."
  - **Verify REFACTOR:** Re-run the new test file.
    - Command: `npx vitest run tests/poke-self-denied-distinct-agents.test.ts`
    - **Observed output (fill during apply):** `Test Files 1 passed (1); Tests 3 passed (3)`.
  - **Commit:** `test(poke): pin self_poke_denied to agent_id equality only`
    - Staging order: test file BEFORE production file (the production file has zero net change after RED→GREEN revert; if `git diff` is empty for `src/mcp/poke.ts`, only the test is committed)
    - **Commit SHA (fill during apply):** 5a8b6bb

## 3. Full suite green gate

- [x] 3.1 Run `pnpm test` and confirm all previously-failing-due-to-this-issue tests are now green and no new regressions
  - kind: build-check
  - **Spec scenario(s):**
    - `agent-interrupts/spec.md` → Scenario: `Caller pokes self` (regression-preserving — confirm still green after fixture changes)
    - `agent-interrupts/spec.md` → Scenario: `Distinct agents are never treated as self-poke` (NEW, full-suite confirmation)
  - **Files:**
    - Modify: `tests/poke-validation.test.ts` (touched by Task 1.1)
    - Modify: `tests/poke-tmux-unavailable.test.ts` (touched by Task 1.2)
    - Modify: `tests/poke-e2e.test.ts` (touched by Task 1.3)
    - Create: `tests/poke-self-denied-distinct-agents.test.ts` (created by Task 2.1)
    - Modify: `src/mcp/poke.ts` (read-only verification — net diff 0)
  - **BUILD-CHECK:** Run `pnpm test` and confirm full-suite pass criteria.
    - Command: `pnpm test`
    - Pass criteria:
      - All 4 originally-failing assertions (`tests/poke-validation.test.ts:94`, `tests/poke-tmux-unavailable.test.ts:54`, `tests/poke-e2e.test.ts:70`, `tests/poke-e2e.test.ts:99`) PASS
      - The new `tests/poke-self-denied-distinct-agents.test.ts` PASSES (all 3 sub-cases)
      - The pre-existing `tests/poke-validation.test.ts:69` (`returns self_poke_denied when caller pokes itself`) STILL PASSES (positive case unaffected)
      - Net failure count strictly less than the pre-change baseline; no NEW failure introduced by this change
    - **Observed output (fill during apply):**
      ```
      Test Files  1 failed | 99 passed (100)
           Tests  1 failed | 312 passed (313)
      ```
      - 4 originally-failing poke assertions now pass (verified via targeted re-run in Task 2.1).
      - New tripwire file `tests/poke-self-denied-distinct-agents.test.ts` passes all 3 sub-cases.
      - Positive `returns self_poke_denied when caller pokes itself` still passes.
      - Net delta vs. pre-change baseline (306/310): +6 tests, -4 targeted failures, total 312/313. Only residual failure is `tests/brand-sweep.test.ts` (unrelated pre-existing issue originating from the WIP `openspec/changes/rename-to-cross-agent-teams-mcp/` directory present on disk before this change; standalone `npx vitest run tests/brand-sweep.test.ts` reproduces the same failure and points at `openspec/specs/daemon-core/spec.md:192,198`, outside the scope of this change).
    - If failure persists: stop and re-investigate; do NOT touch `src/mcp/poke.ts` to "force" a green — design D1 forbids weakening the guard.
  - **Commit:** `chore(test): full suite green gate for fix-poke-self-denied-regressions`
    - Empty commit if no further file edits needed beyond what Tasks 1.x and 2.1 already committed; otherwise stage any final follow-up edits surfaced by the full suite run.
    - **Commit SHA (fill during apply):** 63f44a7

## Scenario Coverage Matrix

| Capability | Scenario | Covered by Task(s) | Test file:line |
|---|---|---|---|
| `agent-interrupts` | `Target never registered pane id` (regression-preserving) | Task 1.1 | `tests/poke-validation.test.ts:84` |
| `agent-interrupts` | `No tmux binary on PATH` (regression-preserving) | Task 1.2 | `tests/poke-tmux-unavailable.test.ts:42` |
| `agent-interrupts` | `Target pane was killed after registration` (regression-preserving) | Task 1.3 | `tests/poke-e2e.test.ts:43` |
| `agent-interrupts` | `Happy path returns before/after tails` (regression-preserving) | Task 1.3 | `tests/poke-e2e.test.ts:78` |
| `agent-interrupts` | `Caller pokes self` (regression-preserving — pre-existing positive case) | Task 3.1 (full-suite confirmation) | `tests/poke-validation.test.ts:69` |
| `agent-interrupts` | `Distinct agents are never treated as self-poke` (NEW, this change) | Task 2.1, Task 3.1 | `tests/poke-self-denied-distinct-agents.test.ts` (3 sub-cases) |

**Coverage:** 6 of 6 scenarios covered (100%).

## Runtime Assumption Audit

This change makes ZERO production code edits (per design D1, the guard at `src/mcp/poke.ts:124` is already canonical). All edits land in test files and one delta spec file. There are no new external defaults, no new probe / cache behavior, no new env vars, no new MCP schema, no new daemon startup paths, no new database columns or constraints. Therefore no Runtime Assumption requires explicit verification beyond the standard `pnpm test` build-check in Task 3.1.

## Integration Readiness Checklist

- [x] Task 1.1 GREEN observed (poke-validation file fully passing)
- [x] Task 1.2 GREEN observed (poke-tmux-unavailable file fully passing)
- [x] Task 1.3 GREEN observed (poke-e2e both scenarios passing on tmux-available host)
- [x] Task 2.1 RED-then-GREEN observed (scratch hypothesis edit caused failure, revert restored pass)
- [x] Task 2.1 production file diff is empty after revert (`git diff src/mcp/poke.ts` returns nothing)
- [x] Task 3.1 full `pnpm test` baseline-delta documented (-4 failures, +3 new tripwire sub-cases green, only remaining failure is pre-existing unrelated brand-sweep)
- [ ] `agent-interrupts/spec.md` MODIFIED Requirement validates against `openspec validate fix-poke-self-denied-regressions --strict`
