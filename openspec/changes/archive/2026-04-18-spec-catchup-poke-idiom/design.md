# Design — spec-catchup-poke-idiom

## Context

Two quick fixes on 2026-04-18 introduced behavioral / tool-description changes without opening an openspec change:

1. `src/mcp/tools.ts:77-120` — `register_agent` returns an optional `hint: string` when `tmux_pane_id` is missing / empty / whitespace.
2. `src/mcp/tools.ts:144-180,200-220` — `send_message`, `broadcast`, `task_add` tool descriptions instruct callers on the "fire-and-forget + optional poke follow-up" idiom.

Tests (`tests/register-agent-hint.test.ts`, `tests/tool-descriptions-poke-hint.test.ts`) and docs (`docs/configs/*`) were updated in the same commits.  But `openspec/specs/{agent-registry,mailbox,task-list}/spec.md` were NOT — leaving a 4-commit gap between shipped behavior and main spec.

This change closes that gap: it's a documentation-only, retroactive spec delta.

## Goals

1. Bring `openspec/specs/{agent-registry,mailbox,task-list}/spec.md` in line with shipped behavior.
2. Provide spec scenarios that the existing test files already cover (no new tests required).
3. Preserve openspec validation (`openspec validate --strict` should pass after sync).
4. Establish the "fire-and-forget + poke follow-up" as a contract, not just a doc string — future agents reading the spec should see it.

## Non-Goals

- **Not** adding any new production code.
- **Not** adding any new test — existing `tests/register-agent-hint.test.ts` (6) and `tests/tool-descriptions-poke-hint.test.ts` (5) are the scenario coverage.
- **Not** changing the `register_agent` wire format further; the `hint` field is already there.
- **Not** introducing spec-level auto-poke semantics (M2/M3 rejected earlier); the spec makes the fire-and-forget contract explicit, which is the M1 position.

## Key Decisions

### 1. Treat as retroactive documentation, not a redo of the fixes

**Decision**: tasks.md only does `build-check` + one `manual-verify`.  No RED → GREEN — the behavior is already GREEN, demonstrated by suite 52 files / 129 tests green on main.

**Rationale**: running RED would require temporarily reverting the shipped code to prove the new spec scenarios fail, then re-applying it.  That's waste — the shipped commits (`8a11198` / `6a40f90` / `6e255ab` / `977e9d7`) already embody the GREEN state, and re-testing them gives the exact same evidence.  The 17-check skipping-RED audit is acceptable here because `tasks.md` declares `build-check` kind, which does not require a RED step.

### 2. Scope tool-description guidance as a spec-level SHOULD

**Decision**: `send_message` / `broadcast` / `task_add` specs add a Requirement like "the tool description SHOULD advise callers of the send-then-poke idiom for urgent delivery".

**Rationale**: tool description text is an LLM-facing UX hint.  Hardcoding the exact string into spec would over-specify (every wording change would be a breaking spec edit).  The SHOULD captures the intent ("LLM must see poke as an option") without locking the prose.

**Rejected alternative**: write a full Requirement that says "tool description MUST contain the substring 'poke'".  Brittle, and fails the LLM-facing-guidance intent.

### 3. Fire-and-forget contract as explicit Requirement

**Decision**: add an `ADDED Requirement: Fire-and-forget delivery contract` to `mailbox` (and the equivalent for `task-list`), which states:

- send_message / broadcast / task_add MUST NOT auto-poke recipient(s)
- Callers MAY chain poke explicitly for urgent delivery
- This contract is the M1 ("caller decides") position, NOT M2/M3 auto-poke

**Rationale**: makes the no-auto-poke guarantee part of the spec, preventing future "let's just add auto-poke" drift.

### 4. No change to register_agent wire-format Requirement — only extend it

**Decision**: the existing `register_agent uses MCP session id as agent_id` Requirement stays intact; body is extended to note the optional `hint?: string` return field; scenarios are added for the hint-present and hint-absent cases.

**Rationale**: minimal surface area change, maximal continuity.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Spec catch-up encourages future "ship code, delay spec" patterns | medium | doc drift culture | this change itself is the correction; principle reinforced in the memory note for next time |
| "Tool description SHOULD contain poke hint" is too vague for reviewers | low | subjective reviews | pair with a regression test `tests/tool-descriptions-poke-hint.test.ts` that asserts `/poke/i` in the description string |
| Sync step (delta → main) has merge surprises | low | spec re-alignment churn | sync agent reviews delta vs main before merging; current delta is append-only (MODIFIED extends body, ADDED adds new requirements) |

## Alternatives Considered

1. **Not catch up at all**: leaves openspec audit log broken.  Future change would have to confront the discrepancy anyway.
2. **Split into three separate changes (one per capability)**: more ceremony for identical reasoning; single change keeps related reasoning in one place.
3. **Catch up only `agent-registry`** (since that's a wire-format change, higher priority) and skip `mailbox` + `task-list`: inconsistent — tool description guidance is also behavior that LLMs rely on.

## Rollout

- Zero code change.
- Zero test change.
- Archiving the change runs `openspec archive`, which syncs the delta into main specs.
- After archive, `openspec validate --strict` should pass cleanly.
