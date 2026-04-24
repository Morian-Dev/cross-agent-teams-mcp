## Context

`refactor-delivery-abstraction` introduced `parseDeliveryRow` as the read-side entry and `validateDeliveryForWrite` as the write-side entry. The two are asymmetric: the write side checks kind + required fields per variant, the read side trusts whatever SQLite returns. `add-codex-appserver-delivery` then made codex-appserver rows writable, so any future corrupted row or partial migration surfaces at the dispatcher.

Separately, `list_agents` returns the raw `AgentListRow[]` from the repo. Each row includes the full `DeliverySpec` payload — fine for internal dispatchers that need `ws_url` / `thread_id`, wrong for peer agents in the same team who only need to know "is this agent routable and by what channel id".

## Goals / Non-Goals

**Goals:**
- `parseDeliveryRow` enforces variant invariants symmetric to `validateDeliveryForWrite`; invalid rows throw `corrupt_delivery_payload`.
- `list_agents` MCP response hides routing-only delivery metadata. Peers see `delivery.kind` and the derived `channel_session_id` top-level field. No `thread_id`, `ws_url`, `auth_token_ref` in the wire response.
- Internal callers (`AgentsRepo.getById`, dispatchers) keep full delivery access — projection happens at the MCP boundary only.

**Non-Goals:**
- W3 migration backfill gate (`needKind || needPayload`). Intentionally out of scope.
- Reshaping `AgentRow` / `AgentListRow` — internal callers depend on the current shape.
- Changing write-path validation (`validateDeliveryForWrite` is already correct).
- Changing `auth_token_ref` semantics (still a ref, still optional, still non-empty when present).

## Decisions

### D1. Read-side validation lives in `parseDeliveryRow`, not a new function

Option A (chosen): Extend `parseDeliveryRow` in place to throw `corrupt_delivery_payload` when `kind` is not in `DELIVERY_KINDS` or when the parsed payload fails variant checks.
Option B: Add a separate `validateDeliveryForRead`, keep `parseDeliveryRow` lenient.

Rationale: Every existing caller of `parseDeliveryRow` would still need to call the new validator, so splitting creates two call sites that must stay in sync. Keeping the check inside `parseDeliveryRow` means every read path is guaranteed to go through validation. The variant checks duplicate `validateDeliveryForWrite` logic at small cost; factoring a shared helper would add more machinery than the duplication saves.

### D2. Public projection defined at the MCP boundary, not inside the repo

Option A (chosen): Introduce a projection function (e.g., `toPublicAgentRow(row: AgentListRow): AgentPublicRow`) colocated with the MCP layer. `list_agents` maps the repo return through this before returning.
Option B: Add a `listPublic()` method on `AgentsRepo` that returns the projected shape.

Rationale: The repo is a storage layer. Projection is an API concern. Putting projection in MCP keeps the repo's contract simple (always full delivery) and makes the MCP boundary's schema the single source of truth for what peers see.

### D3. Public shape is `{kind: DeliveryKind, channel_session_id?: string}`

`delivery` narrows to just the discriminant plus the legacy-visible `channel_session_id` when kind is `claude-channel`. The top-level `channel_session_id: string | null` legacy field is preserved unchanged. For `codex-appserver` and `none`, only `kind` is exposed.

Rationale: `kind` lets peers make UI decisions ("this agent uses X transport") without giving them transport parameters. `channel_session_id` was already in the legacy public API; not removing it here.

## Risks / Trade-offs

- [Risk] Existing `list_agents` consumers may read `delivery.thread_id` or `delivery.ws_url` → [Mitigation] Grep confirmed no such consumers today (`list_agents` was added in refactor-delivery-abstraction and only started returning delivery after that change). The narrowing is acceptable.
- [Risk] Tightening `parseDeliveryRow` may throw on rows that previously parsed leniently → [Mitigation] This is the intended fail-fast behavior per `agent-delivery/spec.md`. `corrupt_delivery_payload` is already a documented error. Callers already handle it via top-level try/catch in MCP handlers.
- [Trade-off] The public-projection helper duplicates the `DeliverySpec` discriminant list → acceptable; `DELIVERY_KINDS` is exported and can be reused.
