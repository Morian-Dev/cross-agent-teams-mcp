## Context

`send_message` is a narrow 1→1 private-message tool. Its recipient is currently addressed exclusively by `to_agent_id` (a UUID).  Cross-team sends work via the optional `to_team` parameter that `refactor-mailbox-routing` adds.  But the UUID is not human-ergonomic and the system already has a unique human-ergonomic key `(team, name)` backed by `agents_identity_idx`.

`list_agents` is scoped to the caller's team, so for cross-team targeting a caller has no programmatic path from `(team, name)` to UUID except "ask the target to reply first" or "have the human paste a UUID". Agents addressing each other by name is the natural idiom.

We add `to_agent_name` as an alternative routing key on `send_message` only. We do NOT add a cross-team `list_agents`, a `resolve_agent` tool, or any other discovery mechanism in this change.

## Goals

- Let callers of `send_message` pick a recipient by `(to_team ?? caller.team, to_agent_name)` without pre-resolving the UUID.
- Preserve full backward compatibility for existing `to_agent_id` callers — same input shape, same success envelope, same error vocabulary.
- Keep the new surface area small and auditable: one optional field, one new error (`ambiguous_recipient` when both fields are given), one lookup call.

## Non-Goals

- No cross-team `list_agents`, no standalone `resolve_agent` MCP tool, no agent directory service.
- No change to `broadcast`, `broadcast_to_role`, `get_inbox`, `poke`, auto-poke fanout, or retry-backoff logic.
- No DB schema changes — we rely on the existing `agents_identity_idx` UNIQUE INDEX on `(team, name)`.
- No change to `send_message`'s success envelope — `recipients[]` continues to hold the UUID regardless of which input path the caller used.

## Decisions

### D1: Mutual-exclusion at the MCP boundary (Zod) AND in the service

Zod can enforce "exactly one of two fields" via `.refine`. We do that at the MCP layer for fast, clear error messages to bad clients. The service layer ALSO re-checks, returning `{ error: 'missing_recipient' }` or `{ error: 'ambiguous_recipient' }` — because `SendMessageService.send` is an internal API that may be called by tests or other code paths without going through Zod.

Error vocabulary:

- Neither given → `{ error: 'missing_recipient' }` (matches the existing error name from the `to_agent_id` / `to_role` validation in the mailbox spec)
- Both given → `{ error: 'ambiguous_recipient' }` (matches the existing error name for the same boundary)

### D2: Resolution happens at the service layer, not in the tool handler

The tool handler forwards the raw input (`{ to_agent_id?, to_agent_name?, to_team?, ... }`) unchanged to `sendSvc.send`. `SendMessageService.send` does the `(team, name)` → UUID resolve, then falls through to the existing insert + auto-poke path with the resolved UUID.

Rationale: the existing "unknown_recipient when recipient's team != resolved to_team" check already runs in the service. Keeping resolution in the service means the cross-team / same-team team-equality check runs in exactly one place.

### D3: Lookup semantics match the UUID path

- Compute `resolved_to_team = to_team ?? caller.team` (same rule as today for the UUID path).
- `AgentsRepo.findByIdentity({ team: resolved_to_team, name: to_agent_name })` returns `{ agent_id } | undefined`.
- `undefined` → `{ error: 'unknown_recipient' }` (same error as the UUID path, intentional — from the caller's perspective both "UUID not found" and "(team, name) not found" mean "the agent I tried to reach does not exist in the team I tried to reach them in").
- Resolved hit → the service proceeds as if the caller had supplied `to_agent_id = <resolved_uuid>`. The existing team-equality check trivially passes because we just looked up the row by `(resolved_to_team, name)`.

### D4: Success envelope unchanged

`recipients: [<resolved_uuid>]` regardless of which input path the caller used. Callers that care about the UUID (for later `poke` calls, for logging) get it back in the response.

### D5: Tool description wording

The updated `SEND_MESSAGE_DESC` adds one sentence noting that `to_agent_name` is the recommended way when the caller knows the target by `(team, name)` rather than by UUID, and that exactly one of `to_agent_id` / `to_agent_name` must be provided. It does NOT encourage cross-team sends by default — the existing "除非用户明确指定 to_team, 不要跨 team 沟通" guardrail stays.

## Runtime Assumptions

No triggers found during the Runtime Assumption Audit. This change does not rely on any external-dependency default behaviour:

- `AgentsRepo.findByIdentity` is an in-project method whose SQL is explicit (`SELECT agent_id FROM agents WHERE team=? AND name=?`) — no library default involved.
- `agents_identity_idx` is a project-owned UNIQUE INDEX declared in `src/storage/schema.ts`; its behaviour (one-row-or-none lookup) is defined by our own schema, not by SQLite's defaults-in-doubt.
- Zod `.refine` and `.strict` behaviour is exercised by existing tests (`send-message-zod-schema.test.ts`) — not a new dependency surface.

Therefore no Runtime Assumption entries are required. The audit is recorded here explicitly per the `ts-propose` rule.

## Integration Readiness Checklist

No bridge types are detected. This change is a self-contained extension of an in-process MCP tool; no SwiftUI/UIKit bridge, no subprocess, no delegate, no threading boundary, no external process.

Single integration-readiness item recorded for auditability:

- **AgentsRepo wiring**: `SendMessageService` already holds a `private agents: AgentsRepo` from its constructor (src/mcp/send-message.ts:50), so `findByIdentity` is reachable without any new constructor plumbing. No new DI wiring is needed.

## Risks / Trade-offs

- **R1 — Ambiguity between "ambiguous recipient" (both fields given) and "multiple matches" (impossible)**: `(team, name)` has a UNIQUE INDEX, so a valid lookup always returns 0 or 1 rows. The `ambiguous_recipient` error here means only "caller gave both `to_agent_id` and `to_agent_name`" — NOT "multiple agents matched". The delta spec wording pins this explicitly.
- **R2 — Callers that rename agents**: agent names are mutable; a cached name may become stale. But this is not a new risk — any caller who keeps a UUID around has the same staleness problem. Mitigated by returning the resolved UUID in `recipients[]` so callers can re-cache at send-time.
- **R3 — Case sensitivity of the lookup**: `findByIdentity` uses raw `=` comparison, which in SQLite defaults to byte-equal on TEXT columns. Callers must match the exact name casing used at register-time. This matches the existing behaviour of `AgentsRepo.register`'s ON CONFLICT clause, so no new divergence is introduced.

## Migration Plan

- Code: additive. Old `to_agent_id`-only callers keep working. New callers MAY use `to_agent_name`.
- DB: no migration.
- Specs: one modified capability (`mailbox`), touching two existing Requirements (recipient-field validation, unknown-recipient handling).
- Ordering: `refactor-mailbox-routing` must archive first (see `proposal.md` → `## Preconditions`), because the Requirements we MODIFY live in that change's delta today.
