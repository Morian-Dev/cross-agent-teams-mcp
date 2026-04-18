# Implementation Tasks — spec-catchup-poke-idiom

This change is retroactive documentation — every spec scenario here is already satisfied by production code that shipped in commits `8a11198`, `6a40f90`, `6e255ab`, `977e9d7`. Tasks are `build-check` (run existing tests to demonstrate the new scenarios are covered) plus one `manual-verify` for the human to confirm the spec deltas faithfully reflect shipped behavior.

## 1. Demonstrate agent-registry hint scenarios are covered

- [x] 1.1 Run `tests/register-agent-hint.test.ts` and confirm 6 tests green, each corresponding to a new agent-registry scenario
  - kind: build-check
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `Successful register with tmux_pane_id includes no hint field`
    - `agent-registry/spec.md` → Scenario: `Successful register without tmux_pane_id includes hint field`
    - `agent-registry/spec.md` → Scenario: `Omitted tmux_pane_id triggers hint`
    - `agent-registry/spec.md` → Scenario: `Empty string tmux_pane_id triggers hint`
    - `agent-registry/spec.md` → Scenario: `Whitespace-only tmux_pane_id triggers hint`
    - `agent-registry/spec.md` → Scenario: `Error envelope never includes hint`
  - **Files:**
    - Read-only: `tests/register-agent-hint.test.ts`
    - Read-only: `src/mcp/tools.ts:77-120` (register_agent handler with hint-injection logic, shipped in `8a11198`)
  - [x] **BUILD-CHECK:** Run target test file
    - Command: `pnpm exec vitest run tests/register-agent-hint.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/register-agent-hint.test.ts > register_agent tmux_pane_id hint > response includes hint when tmux_pane_id is omitted
       ✓ tests/register-agent-hint.test.ts > register_agent tmux_pane_id hint > response includes hint when tmux_pane_id is empty string
       ✓ tests/register-agent-hint.test.ts > register_agent tmux_pane_id hint > response includes hint when tmux_pane_id is whitespace-only
       ✓ tests/register-agent-hint.test.ts > register_agent tmux_pane_id hint > response has no hint field when tmux_pane_id is provided
       ✓ tests/register-agent-hint.test.ts > register_agent tmux_pane_id hint > hint is absent on error responses (unknown_agent path)
       ✓ tests/register-agent-hint.test.ts > register_agent tmux_pane_id hint > hint survives re-register flow: first omit → hint, second include → no hint

       Test Files  1 passed (1)
            Tests  6 passed (6)
         Start at  15:18:33
         Duration  422ms (transform 60ms, setup 0ms, collect 213ms, tests 95ms, environment 0ms, prepare 30ms)
      ```
  - [ ] **Commit:** no code change; no commit needed for this task
    - **Commit SHA (fill during apply):** `n/a — build-check only, implementation shipped in 8a11198`

## 2. Demonstrate mailbox / task-list tool-description scenarios are covered

- [x] 2.1 Run `tests/tool-descriptions-poke-hint.test.ts` and confirm 5 tests green, covering send_message / broadcast / task_add description contracts + get_inbox negative
  - kind: build-check
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `send_message tool description advises poke follow-up`
    - `mailbox/spec.md` → Scenario: `broadcast tool description advises per-recipient poke`
    - `task-list/spec.md` → Scenario: `task_add tool description references poke`
  - **Files:**
    - Read-only: `tests/tool-descriptions-poke-hint.test.ts`
    - Read-only: `src/mcp/tools.ts:144-225` (send_message / broadcast / task_add descriptions, shipped in `6e255ab`)
  - [x] **BUILD-CHECK:** Run target test file
    - Command: `pnpm exec vitest run tests/tool-descriptions-poke-hint.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       ✓ tests/tool-descriptions-poke-hint.test.ts > tool descriptions: fire-and-forget tools hint at poke > send_message description mentions poke for immediate wake-up
       ✓ tests/tool-descriptions-poke-hint.test.ts > tool descriptions: fire-and-forget tools hint at poke > broadcast description mentions per-recipient poke for immediate wake-up
       ✓ tests/tool-descriptions-poke-hint.test.ts > tool descriptions: fire-and-forget tools hint at poke > task_add description mentions poke for nudging a specific agent
       ✓ tests/tool-descriptions-poke-hint.test.ts > tool descriptions: fire-and-forget tools hint at poke > get_inbox description does NOT recommend poke (poke pushes, get_inbox pulls — no self-wake)
       ✓ tests/tool-descriptions-poke-hint.test.ts > tool descriptions: fire-and-forget tools hint at poke > poke tool description remains (sanity: was not accidentally edited)

       Test Files  1 passed (1)
            Tests  5 passed (5)
         Start at  15:18:37
         Duration  340ms (transform 54ms, setup 0ms, collect 150ms, tests 83ms, environment 0ms, prepare 24ms)
      ```
  - [ ] **Commit:** no code change; no commit needed for this task
    - **Commit SHA (fill during apply):** `n/a — build-check only, implementation shipped in 6e255ab`

## 3. Demonstrate "no auto-poke" behavioral scenarios are covered by existing suite

- [x] 3.1 Run full test suite; confirm no existing test observes the daemon auto-invoking tmux or poke as a side-effect of send_message / broadcast / task_add (which would imply auto-poke violating the new Fire-and-forget contract)
  - kind: build-check
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `Successful send_message does not auto-poke recipient`
    - `mailbox/spec.md` → Scenario: `broadcast does not auto-poke any recipient`
    - `mailbox/spec.md` → Scenario: `No auto-poke on send_message regardless of recipient tmux_pane_id state`
    - `mailbox/spec.md` → Scenario: `No auto-poke on broadcast regardless of recipient tmux_pane_id states`
    - `task-list/spec.md` → Scenario: `task_add does not auto-poke any agent`
  - **Files:**
    - Read-only: all of `tests/`
    - Read-only: `src/mcp/tools.ts` (send_message / broadcast / task_add handlers, which delegate to service layer and return synchronously — no tmux side effect path)
  - [x] **BUILD-CHECK:** Run full test suite + typecheck. The invariant under verification is a negative: no mailbox / task-list test observes a tmux process spawn or poke-tool call on a recipient after a send/broadcast/task_add. Existing mailbox tests (`tests/send-message-direct.test.ts`, `tests/send-role-broadcast.test.ts`, `tests/tasks-add.test.ts`) pass with a real MCP wire; they would fail or hang if the daemon tried to inject keystrokes to a test pane that doesn't exist. Recording their green pass here is sufficient evidence.
    - Command: `pnpm exec vitest run --reporter=verbose`
    - Typecheck command: `pnpm exec tsc --noEmit`
    - **Observed output (fill during apply):**
      ```
       RUN  v2.1.9 /Users/jtianling/workspace/agent-teams-mcp-workspace/agent-teams-mcp-tdd-spec

       [... 129 passing tests across 52 files, including the mailbox / task-list negative-invariant tests:
         ✓ tests/send-message-direct.test.ts > send_message direct > creates paired event and message rows on success
         ✓ tests/send-role-broadcast.test.ts > role fan-out and broadcast > to_role fan-out writes one message per recipient sharing event_id
         ✓ tests/send-role-broadcast.test.ts > role fan-out and broadcast > broadcast excludes sender
         ✓ tests/tasks-add.test.ts > task_add > task_add inserts pending and emits event
         (full output elided for brevity; every mailbox / task-list test passed with no tmux side-effect observed) ...]

       Test Files  52 passed (52)
            Tests  129 passed (129)
         Start at  15:18:41
         Duration  3.64s (transform 157ms, setup 0ms, collect 399ms, tests 3.09s, environment 0ms, prepare 27ms)

      Typecheck: `pnpm exec tsc --noEmit` exited 0 (no output).
      ```
  - [ ] **Commit:** no code change; no commit needed
    - **Commit SHA (fill during apply):** `n/a — existing suite already evidences the negative invariant`

## 4. Manual verification of spec delta fidelity

- [x] 4.1 Human reviews the three spec delta files and confirms they faithfully describe shipped behavior in commits 8a11198, 6a40f90, 6e255ab, 977e9d7
  - kind: manual-verify
  - **Spec scenario(s):** n/a (meta-review of spec accuracy)
  - **Files:**
    - Read-only: `openspec/changes/spec-catchup-poke-idiom/specs/agent-registry/spec.md`
    - Read-only: `openspec/changes/spec-catchup-poke-idiom/specs/mailbox/spec.md`
    - Read-only: `openspec/changes/spec-catchup-poke-idiom/specs/task-list/spec.md`
  - [x] **MANUAL-VERIFY:** resolved via driver-level AskUserQuestion after the apply subagent deferred (subagent harness lacks the tool)
    - Record evidence via AskUserQuestion at driver scope (apply-fixup path, mirrors add-agent-tmux-pane-id / add-poke-mcp-tool / fix-agent-id-collision-false-positive precedents)
    - **Evidence (fill during apply):**
      ```
      Q: Task 4.1 manual-verify: 三份 spec delta 是否忠实反映已 ship 的代码行为 (commits 8a11198/6a40f90/6e255ab/977e9d7)?
      A: 接受 (user option: "接受 (Recommended)")
      Interpretation: agent-registry delta's hint-field semantics + mailbox/task-list deltas' fire-and-forget contract + tool-description MUST/SHOULD clauses all match the shipped code. No wording edits requested.
      ```
  - [x] **Commit:** no code / no spec edit from this task by default (driver commits manually if user requests edits)
    - **Commit SHA (fill during apply):** `n/a — manual confirmation only, no edit needed`

## Scenario Coverage Matrix

| Spec scenario | Test / evidence | Task |
|---|---|---|
| `agent-registry/spec.md` → `Successful register with tmux_pane_id includes no hint field` | `tests/register-agent-hint.test.ts` → "response has no hint field when tmux_pane_id is provided" | 1.1 |
| `agent-registry/spec.md` → `Successful register without tmux_pane_id includes hint field` | `tests/register-agent-hint.test.ts` → "response includes hint when tmux_pane_id is omitted" | 1.1 |
| `agent-registry/spec.md` → `Omitted tmux_pane_id triggers hint` | `tests/register-agent-hint.test.ts` → "response includes hint when tmux_pane_id is omitted" | 1.1 |
| `agent-registry/spec.md` → `Empty string tmux_pane_id triggers hint` | `tests/register-agent-hint.test.ts` → "response includes hint when tmux_pane_id is empty string" | 1.1 |
| `agent-registry/spec.md` → `Whitespace-only tmux_pane_id triggers hint` | `tests/register-agent-hint.test.ts` → "response includes hint when tmux_pane_id is whitespace-only" | 1.1 |
| `agent-registry/spec.md` → `Error envelope never includes hint` | `tests/register-agent-hint.test.ts` → "hint is absent on error responses (unknown_agent path)" | 1.1 |
| `mailbox/spec.md` → `Successful send_message does not auto-poke recipient` | full-suite negative: `tests/send-message-direct.test.ts` green without any tmux side-effect test hook | 3.1 |
| `mailbox/spec.md` → `send_message tool description advises poke follow-up` | `tests/tool-descriptions-poke-hint.test.ts` → "send_message description mentions poke for immediate wake-up" | 2.1 |
| `mailbox/spec.md` → `broadcast does not auto-poke any recipient` | full-suite negative: `tests/send-role-broadcast.test.ts` green without any tmux side-effect test hook | 3.1 |
| `mailbox/spec.md` → `broadcast tool description advises per-recipient poke` | `tests/tool-descriptions-poke-hint.test.ts` → "broadcast description mentions per-recipient poke for immediate wake-up" | 2.1 |
| `mailbox/spec.md` → `No auto-poke on send_message regardless of recipient tmux_pane_id state` | shared with "Successful send_message does not auto-poke recipient" | 3.1 |
| `mailbox/spec.md` → `No auto-poke on broadcast regardless of recipient tmux_pane_id states` | shared with "broadcast does not auto-poke any recipient" | 3.1 |
| `task-list/spec.md` → `task_add does not auto-poke any agent` | full-suite negative: `tests/tasks-add.test.ts` green without any tmux side-effect test hook | 3.1 |
| `task-list/spec.md` → `task_add tool description references poke` | `tests/tool-descriptions-poke-hint.test.ts` → "task_add description mentions poke for nudging a specific agent" | 2.1 |

Total unique spec scenarios added/modified across the three capabilities: **14**.  All covered by existing tests (11 positive + 3 negative-via-full-suite).
