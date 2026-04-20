# Tasks

## 1. Rewrite main spec prose to avoid self-match

- [ ] 1.1 RED: add literal-free assertion + rewrite `openspec/specs/daemon-core/spec.md`
  - kind: unit-test
  - **Spec scenario(s):**
    - `daemon-core/spec.md` → Scenario: `Main daemon-core spec file is literal-free` (NEW)
  - **Files:**
    - Create: `tests/brand-sweep-spec-self-check.test.ts`
    - Modify: `openspec/specs/daemon-core/spec.md`
  - **RED:** Create the new test file `tests/brand-sweep-spec-self-check.test.ts` with a first `it()` block that reads `openspec/specs/daemon-core/spec.md` via `fs.readFileSync` and asserts `content.includes(LEGACY_BRAND)` is `false`, where `LEGACY_BRAND = ['ts', 'agent', 'teams'].join('-')`. Before rewriting the spec, running this test yields RED because the current spec contains the literal at lines 192 and 198.
    - Behavior under test: the main-spec file describing the brand-sweep invariant must not itself carry the forbidden literal as a contiguous substring.
    - Expected failure reason: `openspec/specs/daemon-core/spec.md` currently embeds the literal twice (Requirement body + Scenario grep example).
  - **Verify RED:** Run the new test file.
    - Command: `npx vitest run tests/brand-sweep-spec-self-check.test.ts`
    - **Observed output (fill during apply):**
      ```
      (to be filled during apply)
      ```
  - **GREEN:** Edit `openspec/specs/daemon-core/spec.md`:
    - Replace the Requirement body so it opens with a lookup block: "In this Requirement, `<legacy-brand>` denotes the string equal to `'ts'` concatenated with `'-agent-teams'` (total 13 characters, case-sensitive, ASCII)."
    - Rewrite the SHALL-statement to reference `<legacy-brand>` instead of the literal.
    - Rewrite the `#### Scenario: Brand-sweep grep returns zero matches` WHEN clause so the example grep command uses `<legacy-brand>` as the pattern placeholder, with a clarifying note that the placeholder resolves to the concatenated string at evaluation time.
    - Verify by grep: `grep -c "$(printf 'ts'; printf -- '-agent-teams')" openspec/specs/daemon-core/spec.md` returns `0` (the shell-built needle equals the `<legacy-brand>` placeholder defined in the delta spec).
  - **Verify GREEN:** Re-run the self-check.
    - Command: `npx vitest run tests/brand-sweep-spec-self-check.test.ts`
    - **Observed output (fill during apply):**
      ```
      (to be filled during apply)
      ```
  - **REFACTOR:** Optionally add an in-spec footnote explaining the placeholder convention is chosen for sweep-safety. Not required for correctness.
  - **Verify REFACTOR:** Re-run the self-check.
    - Command: `npx vitest run tests/brand-sweep-spec-self-check.test.ts`
    - **Observed output (fill during apply):** `(to be filled during apply)`.
  - **Commit:** `fix(spec): rewrite daemon-core brand invariant with placeholder to avoid sweep self-match`
    - Staging order: spec file + new test file together (tripwire created alongside rewrite).

## 2. Defense-in-depth sweep allowlist

- [ ] 2.1 RED: add allowlist assertion; extend `tests/brand-sweep.test.ts` to exclude the daemon-core spec directory
  - kind: unit-test
  - **Spec scenario(s):**
    - `daemon-core/spec.md` → Scenario: `Allowlist covers the main daemon-core spec file as defense in depth` (NEW)
  - **Files:**
    - Modify: `tests/brand-sweep-spec-self-check.test.ts`
    - Modify: `tests/brand-sweep.test.ts`
  - **RED:** Extend `tests/brand-sweep-spec-self-check.test.ts` with a second `it()` block that reads `tests/brand-sweep.test.ts` as a string and asserts its content contains either `--exclude-dir=daemon-core` (as a literal argument string in the argv builder) OR a path-aware allowlist entry mentioning `daemon-core` in the excludes. Before editing `tests/brand-sweep.test.ts`, this sub-test is RED because the allowlist lacks any daemon-core entry.
    - Behavior under test: the sweep's allowlist must categorically exempt the main daemon-core spec directory so any future literal-prose regression in `openspec/specs/daemon-core/spec.md` does not fail CI via the sweep path (the dedicated tripwire at Task 1.1 still catches it).
    - Expected failure reason: the current `ANTI_BRAND_ASSERTION_EXCLUDES` list contains only 4 test-file basenames; no daemon-core reference.
  - **Verify RED:** Run the expanded self-check file.
    - Command: `npx vitest run tests/brand-sweep-spec-self-check.test.ts`
    - **Observed output (fill during apply):**
      ```
      (to be filled during apply)
      ```
  - **GREEN:** Edit `tests/brand-sweep.test.ts`:
    - Add `--exclude-dir=daemon-core` to the `excludeArgs` builder (alongside the existing per-file `--exclude=<name>` entries). Place a short inline comment marking: "daemon-core dir holds the spec that describes the invariant by negative assertion; see change fix-brand-sweep-self-match."
    - Sanity: confirm `--exclude-dir` applies directory-wide within ACTIVE_PATHS and does not accidentally exclude any other `daemon-core` path (there is only one such directory: `openspec/specs/daemon-core/`).
  - **Verify GREEN:** Re-run the expanded self-check and the sweep itself.
    - Command: `npx vitest run tests/brand-sweep-spec-self-check.test.ts tests/brand-sweep.test.ts`
    - **Observed output (fill during apply):**
      ```
      (to be filled during apply)
      ```
  - **REFACTOR:** None beyond the inline comment.
  - **Verify REFACTOR:** Re-run both test files.
    - Command: `npx vitest run tests/brand-sweep-spec-self-check.test.ts tests/brand-sweep.test.ts`
    - **Observed output (fill during apply):** `(to be filled during apply)`.
  - **Commit:** `test(brand-sweep): exclude daemon-core spec dir as defense in depth`
    - Staging order: both test files together.

## 3. Full suite green gate

- [ ] 3.1 Run `pnpm test` and confirm the brand-sweep failure is resolved with no new regressions
  - kind: build-check
  - **Spec scenario(s):**
    - `daemon-core/spec.md` → Scenario: `Brand-sweep grep returns zero matches` (MODIFIED, regression-preserving)
    - `daemon-core/spec.md` → Scenario: `Main daemon-core spec file is literal-free` (NEW, full-suite confirmation)
    - `daemon-core/spec.md` → Scenario: `Allowlist covers the main daemon-core spec file as defense in depth` (NEW, full-suite confirmation)
  - **Files:**
    - Modify: `openspec/specs/daemon-core/spec.md` (touched by Task 1.1)
    - Modify: `tests/brand-sweep.test.ts` (touched by Task 2.1)
    - Create: `tests/brand-sweep-spec-self-check.test.ts` (created by Task 1.1, extended by Task 2.1)
  - **BUILD-CHECK:** Run `pnpm test` and confirm full-suite pass criteria.
    - Command: `pnpm test`
    - Pass criteria:
      - `tests/brand-sweep.test.ts` PASSES (no hits in ACTIVE_PATHS).
      - `tests/brand-sweep-spec-self-check.test.ts` PASSES (both sub-cases: spec file literal-free + allowlist includes daemon-core).
      - The pre-existing 312 passing tests STILL PASS (no regression).
      - The pre-change baseline failure (1 failure in `tests/brand-sweep.test.ts`) is now resolved.
      - Net failure count strictly less than the pre-change baseline; no NEW failure introduced.
    - **Observed output (fill during apply):**
      ```
      (to be filled during apply)
      ```
    - If failure persists: stop and re-investigate; do NOT weaken the sweep's ACTIVE_PATHS coverage or silently drop any invariant.
  - **Commit:** `chore(test): full suite green gate for fix-brand-sweep-self-match`
    - Empty commit if no further file edits are surfaced by the full suite run; otherwise stage any final follow-up edits.

## Scenario Coverage Matrix

| Capability | Scenario | Covered by Task(s) | Test file:line |
|---|---|---|---|
| `daemon-core` | `Brand-sweep grep returns zero matches` (MODIFIED, regression-preserving) | Task 1.1, Task 2.1, Task 3.1 | `tests/brand-sweep.test.ts` |
| `daemon-core` | `Main daemon-core spec file is literal-free` (NEW) | Task 1.1, Task 3.1 | `tests/brand-sweep-spec-self-check.test.ts` (sub-case 1) |
| `daemon-core` | `Allowlist covers the main daemon-core spec file as defense in depth` (NEW) | Task 2.1, Task 3.1 | `tests/brand-sweep-spec-self-check.test.ts` (sub-case 2) |

**Coverage:** 3 of 3 scenarios covered (100%).

## Runtime Assumption Audit

This change makes ZERO production code edits. All edits land in documentation (`openspec/specs/daemon-core/spec.md`) and test files. There are no new external defaults, no new probe / cache behavior, no new env vars, no new MCP schema, no new daemon startup paths, no new database columns or constraints. Therefore no Runtime Assumption requires explicit verification beyond the standard `pnpm test` build-check in Task 3.1.

## Integration Readiness Checklist

- [ ] Task 1.1 RED-then-GREEN observed (tripwire test fails before rewrite, passes after)
- [ ] Task 2.1 RED-then-GREEN observed (allowlist assertion fails before `--exclude-dir`, passes after)
- [ ] Task 3.1 full `pnpm test` baseline-delta documented (-1 failure, +2 new tripwire sub-cases green)
- [ ] `grep -c "$(printf 'ts'; printf -- '-agent-teams')" openspec/specs/daemon-core/spec.md` returns `0` after Task 1.1 GREEN (shell-built needle equals `<legacy-brand>`)
- [ ] `openspec validate fix-brand-sweep-self-match --strict` passes
