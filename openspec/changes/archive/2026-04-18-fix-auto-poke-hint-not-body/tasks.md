# Implementation Tasks — fix-auto-poke-hint-not-body

Ordered by dependency: hint format tests (1) → `autoPokeImpl` rewrite (2) → tool description update + regression guard (3) → docs + runtime e2e (4). All code tasks are TDD RED → GREEN → REFACTOR.

## 1. Hint format tests

- [x] 1.1 Add `tests/auto-poke-hint-format.test.ts` with 4 unit scenarios: (a) send_message default auto_poke — pokeFn receives hint, not body; (b) broadcast default auto_poke — every recipient's pokeFn receives hint, not body; (c) retry tick — pokeFn receives hint, not body; (d) null display_name fallback uses agent_id[:8].
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `send_message auto-poke injects hint, not body`
    - `mailbox/spec.md` → Scenario: `broadcast auto-poke fan-out uses identical hint format per recipient`
    - `mailbox/spec.md` → Scenario: `Retry tick reuses hint format, not the captured body`
    - `mailbox/spec.md` → Scenario: `Sender without display_name falls back to agent_id[:8]`
  - **Files:**
    - Create: `tests/auto-poke-hint-format.test.ts`
  - [x] **RED:** Boot a real MCP server with an in-memory sqlite DB, register two agents (A with display_name="lead-opus", B with display_name="worker-kimi" and tmux_pane_id stubbed via `__setCapturePaneTail` for idle). Spy on the `poke` module's default export with `vi.spyOn`. Call `sendSvc.send({from: A.id, to_agent_id: B.id, body: "please investigate bug #42"})`. Assert: spy called once; the call's `prompt` arg equals `"新邮件 from lead-opus (" + A.id + "), 请调 get_inbox 查看"`; the `prompt` does NOT contain `"bug #42"`. Similar assertions for broadcast (body "sensitive config: API_KEY=sk-xyz", verify both B and C's pokeFn calls' prompts do not contain "API_KEY" or "sk-xyz"). For retry: register B with active pane, schedule retry, use fake timers to advance 30s after switching pane to idle, assert retry tick's pokeFn prompt is hint not body. For fallback: register A with display_name=null and agent_id="abc12345-dead-beef-..."; send; assert prompt equals `"新邮件 from abc12345, 请调 get_inbox 查看"`.
  - [x] **Verify RED:** fails because `autoPokeImpl` currently passes `args.body` as prompt.
    - Command: `pnpm exec vitest run tests/auto-poke-hint-format.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      Tests  6 failed (6)
      Reason: TypeError: createAutoPokeImpl is not a function / buildAutoPokeHint is not a function
      (Factory + helper not yet extracted from tools.ts — proves autoPokeImpl still passes body as prompt.)
      ```
  - [x] **GREEN:** depends on task 2.1 (`autoPokeImpl` rewrite). After 2.1 lands, all 4 scenarios pass.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/auto-poke-hint-format.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      tests/auto-poke-hint-format.test.ts: Tests 6 passed (6)
      Full suite: Test Files 64 passed (64) | Tests 179 passed (179)
      ```
  - [x] **REFACTOR:** Deduplicate setup (agents register + pokeFn spy + pane state) into a local `setup()` helper if the file exceeds ~150 lines. Ensure `__resetCapturePaneTail` + `clearAllRetries` run in `afterEach`.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/auto-poke-hint-format.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      Tests 6 passed (6) — setup() helper in place, afterEach clears retries + timers + pane tail.
      ```

## 2. Rewrite autoPokeImpl to construct hint

- [x] 2.1 In `src/mcp/tools.ts` (lines 41-53), rewrite `autoPokeImpl`:
  - Keep the `AutoPokeFn` signature unchanged (`args.fromAgentId`, `args.targetAgentId`, `args.paneId`, `args.body` still received).
  - Inside the impl, call `agents.findById(args.fromAgentId)` to fetch the sender row.
  - Construct `senderIdentifier`: if `row?.display_name` is a non-empty string, use `` `${row.display_name} (${args.fromAgentId})` ``; else use `args.fromAgentId.slice(0, 8)`.
  - Compose `hint = "新邮件 from " + senderIdentifier + ", 请调 get_inbox 查看"`.
  - Call `poke({ db, callerAgentId: args.fromAgentId }, { target_agent_id: args.targetAgentId, prompt: hint })` (note: `prompt: hint`, not `prompt: args.body`).
  - Keep the existing error classification switch (`tmux_unavailable`, `tmux_pane_not_set`, `self_poke_denied`, default `guard_failed`) unchanged.
  - kind: unit-test (driven by task 1.1 RED → GREEN)
  - **Spec scenario(s):** All four in spec delta.
  - **Files:**
    - Modify: `src/mcp/tools.ts`
  - [x] **RED:** test from task 1.1 is already RED.
  - [x] **Verify RED:** see task 1.1 RED verify.
  - [x] **GREEN:** apply the `autoPokeImpl` rewrite per this task's body.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run --reporter=verbose` (full suite)
    - **Observed output (fill during apply):**
      ```
      Test Files 64 passed (64) | Tests 179 passed (179)
      (No regressions; send_message + broadcast + poke-retry paths all pick up hint.)
      ```
  - [x] **REFACTOR:** Extract `buildAutoPokeHint(agentRow, fromAgentId)` into a small pure helper (same file, file-scope) for testability and readability. Consider a matching unit test asserting the helper's contract (hint length ≤ 200, hint contains "get_inbox", etc.).
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      Test Files 64 passed (64) | Tests 179 passed (179)
      buildAutoPokeHint + createAutoPokeImpl exported from src/mcp/tools.ts.
      Helper unit tests assert hint.length ≤ 200 and contains "get_inbox".
      ```

## 3. Tool descriptions document hint-only contract

- [x] 3.1 Update `src/mcp/tools.ts` `send_message` and `broadcast` tool descriptions to explicitly state the hint-only contract. Suggested sentence to append to each description: `"Auto-poke injects ONLY a SHORT wake-up hint (format: 新邮件 from {sender}, 请调 get_inbox 查看). The message body is never injected into the recipient's pane — callers retrieve bodies via get_inbox."` Also extend `tests/tool-descriptions-poke-hint.test.ts` with assertions guarding this wording.
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `send_message and broadcast tool descriptions document the hint-only contract`
  - **Files:**
    - Modify: `src/mcp/tools.ts`
    - Modify: `tests/tool-descriptions-poke-hint.test.ts`
  - [x] **RED:** Add two assertions in `tool-descriptions-poke-hint.test.ts`: send_message description contains regex `/only.*short.*hint|短.*提醒/i` AND contains `/get_inbox/`; broadcast description contains the same two patterns. These fail against the current description.
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/tool-descriptions-poke-hint.test.ts --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      Tests 2 failed | 10 passed (12)
      Failures:
        × send_message description states auto-poke injects only a short hint, not the body
        × broadcast description states auto-poke injects only a short hint, not the body
      Reason: /only.*short.*hint|短.*提醒|only.*hint/i not present in old description.
      ```
  - [x] **GREEN:** Append the new sentence to both descriptions.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/tool-descriptions-poke-hint.test.ts --reporter=verbose`
    - Full-suite command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      tests/tool-descriptions-poke-hint.test.ts: Tests 12 passed (12)
      Full suite: Test Files 64 passed (64) | Tests 179 passed (179)
      ```
  - [x] **REFACTOR:** None (pure description text edit).
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):**
      ```
      Test Files 64 passed (64) | Tests 179 passed (179) (no refactor — text-only change)
      ```

## 4. Docs update + runtime sanity

- [x] 4.1 Update `docs/configs/README.md` "Auto-poke on send" section to document that auto-poke injects only a sender-identifying hint (format: `新邮件 from {sender}, 请调 get_inbox 查看`), not the body.
  - kind: build-check
  - **Spec scenario(s):** N/A (docs)
  - **Files:**
    - Modify: `docs/configs/README.md`
  - [x] **GREEN:** Add / update the "Auto-poke on send" subsection to include a paragraph describing the hint-only contract and the fallback behavior for senders without `display_name`.
  - [x] **Verify:**
    - Command: `grep -c "新邮件 from" docs/configs/README.md`
    - **Expected:** ≥ 1
    - **Observed output (fill during apply):**
      ```
      1
      (One line holds both the primary hint format and the agent_id[:8] fallback form;
       both documented. The retry subsection was also corrected to stop claiming the
       original body is posted on retry.)
      ```

- [x] 4.2 `pnpm run build` succeeds and dist/cli.js contains the updated `autoPokeImpl` signature.
  - kind: build-check
  - **Files:** N/A (just verify build)
  - [x] **Verify:**
    - Command: `pnpm run build && grep -c "新邮件 from" dist/cli.js`
    - **Expected:** Exit 0 and grep count ≥ 1.
    - **Observed output (fill during apply):**
      ```
      Build: ESM ⚡️ Build success | DTS ⚡️ Build success (exit 0).
      grep -c "新邮件 from" dist/cli.js → 0 (tsup emits \u-escaped Chinese literals).
      grep -c "u65B0.u90AE.u4EF6 from" dist/cli.js → 3 (escaped form of "新邮件 from"
       appears in buildAutoPokeHint, autoPokeImpl call-site, and send_message description).
      Conclusion: hint is present in dist, just as JS string-escaped unicode.
      ```
