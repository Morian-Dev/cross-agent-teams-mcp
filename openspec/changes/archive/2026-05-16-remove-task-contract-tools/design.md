## Context

`cross-agent-teams-mcp` currently exposes ~25 MCP tools split across three concerns:

1. **Registration / identity** — `register_agent`, `unregister_self`, `list_agents`, `bind_*`, `pre_register_codex_pane`, `subscribe_channel_wake`.
2. **Messaging** — `send_message`, `send_message_by_id`, `broadcast`, `broadcast_to_role`, `get_inbox`, `get_delivery_status`, `echo`.
3. **Structured collaboration (unused)** — `task_add` / `task_claim` / `task_complete` / `task_list` and `register_contract` / `subscribe_contract` / `get_contract` / `diff_contracts` / `pending_contract_events`.

The third group ships its own SQLite tables (`tasks`, `contracts`, `contract_subscriptions`), service files (`src/mcp/task-*.ts`, `src/mcp/*contract*.ts`), event types in the outbox, and 11 dedicated test files.  In real use the user (jt) and the agents always negotiate task allocation and version compatibility in chat — the structured tools are dead weight.

Removing them is mostly mechanical, but it has three sharp edges:

1. `unregister_self` currently refuses to unregister callers that own in-progress tasks.  Stripping the guard simplifies the tool but changes its response union.
2. `events_outbox`'s cleanup contract enumerates `tasks` / `contracts` / `contract_subscriptions` as survivors of age-based cleanup.  Those clauses become dead text after the tables drop.
3. The DB schema currently creates the 3 tables on every boot.  We need a deterministic "drop on first boot of the new version" story without leaving zombie rows.

## Goals / Non-Goals

**Goals:**

- Reduce the MCP tool surface to the 15-tool "registration + messaging" core.
- Delete all dead service / test / spec / doc surface in a single sweep — no transitional shim, no `@deprecated` aliases.
- Keep all surviving tools' input schemas, output schemas, and observable behavior **bit-identical**.
- Land a clean `CHANGELOG.md` entry that documents this as a **BREAKING** release.

**Non-Goals:**

- Rebuilding any of the removed semantics under a new name.
- Migrating data out of `tasks` / `contracts` / `contract_subscriptions`.  Existing rows are discarded; users never relied on them.
- Touching the daemon transport, channel proxy, runtime identity binding, or tmux pane detection.
- Deciding the exact version bump (`0.6.0` vs `1.0.0`).  That is a release-time call.  This change only enforces that `CHANGELOG.md` carries a loud BREAKING entry.

## Decisions

### D1. Drop tables outright on first boot; no migration

When the daemon starts on the new version, `schema.ts` simply omits `CREATE TABLE IF NOT EXISTS tasks/contracts/contract_subscriptions`.  In addition, the boot path issues `DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS contracts; DROP TABLE IF EXISTS contract_subscriptions;` once so existing installs reclaim disk.

Alternatives considered:

- **Leave tables in place**: rejected — leaves confusing dead schema that future readers have to explain.
- **Migration script that exports rows first**: rejected — overkill for an unused feature; jt confirmed the data is disposable.

### D2. `unregister_self` becomes guard-free

The `tasks_in_progress` short-circuit is removed entirely.  The response union shrinks from

```
{ ok: true } | { error: 'tasks_in_progress'; task_ids: string[] } | { error: 'unknown_agent' } | ...
```

to

```
{ ok: true } | { error: 'unknown_agent' } | ...
```

`agents-repo.listClaimedInProgressTaskIds` is deleted with it.

Alternatives considered:

- **Keep the guard but always return `task_ids: []`**: rejected — leaves a vestigial error type forever.

### D3. Outbox event-type enum drops task/contract members; no historical rewrite

The events outbox is append-only.  Old rows on existing installs may carry `event_type IN ('task_added', 'task_claimed', 'task_completed', 'contract_registered', 'contract_event')`.  The cleanup contract no longer enumerates `tasks` / `contracts` / `contract_subscriptions` as survivors (those tables are gone), but it MUST NOT actively delete legacy event rows — they age out via the 30-day TTL like any other row.

Alternatives considered:

- **Backfill / delete old event rows during DB migration**: rejected — same reason as D1: not worth the migration code.

### D4. Spec deletions go through OpenSpec normally; no "merge & archive" trick

Three full specs (`task-list`, `contract-registry`, `contract-subscriptions`) are deleted via standard `openspec` delta machinery: this change's `specs/<name>/spec.md` files mark the entire prior spec as REMOVED.  After `openspec sync` / `openspec archive`, `openspec/specs/<name>/spec.md` files vanish from main specs.

Four specs receive small modify deltas:

- `agent-registry` — drop `tasks_in_progress` requirement + scenario from `unregister_self`.
- `events-outbox` — drop task/contract event-type names from enumeration + drop the "ancient contracts survive cleanup" scenario.
- `daemon-core` — drop the heartbeat scenario tied to `contract_event` delivery.
- `mailbox` — drop the requirement that pinned `task_add` to "pure task-list mutation".

### D5. Tests deleted, not skipped

The 11 dedicated test files plus any leftover task/contract assertions in survivor tests are removed in the same change.  `vitest` SHALL still pass with zero `.skip` / `xfail` markers introduced.

### D6. Documentation reduction is mechanical

`README.md`, `README.zh-CN.md`, `AGENTS.md`, and `docs/` task/contract sections are deleted in the same change.  Their "Tools" tables shrink to the 15-tool surface.  No "feature was removed, see PR #X" tombstone — `CHANGELOG.md` is the single source of truth for the removal.

## Risks / Trade-offs

- **External users break silently** → Mitigation: loud **BREAKING** marker in `CHANGELOG.md`, optional major-version bump.  No data loss because the features were unused.
- **Existing DB files have orphan rows in `events` referencing dead event types** → Mitigation: D3 — those rows age out via the existing 30-day TTL; no consumer reads them post-removal.
- **Hidden coupling in surviving tests** (e.g., a broadcast test that happens to seed a `tasks` row) → Mitigation: full `vitest` run after deletion; any failures are mechanical fixups (delete the seeding) and surface during the verify phase.
- **`mcpsmgr` / `steward` cross-device clients call removed tools** → Mitigation: jt confirmed nobody else relies on them.  If a downstream client does call them, it receives "unknown tool" from the MCP server — fail-fast is the desired behavior.

## Migration Plan

1. Land this change on a branch.  No data migration step is required.
2. Cut a release tagged with a **BREAKING** CHANGELOG entry.  The release pipeline (`release` branch → GitHub Actions OIDC) is untouched.
3. On first boot of the new version, the daemon executes the `DROP TABLE IF EXISTS …` statements once; subsequent boots are no-ops.
4. No rollback path is provided: rolling back to a `0.5.x` daemon against a DB that has had its tables dropped means `0.5.x` recreates empty tables.  Users who downgrade lose nothing because the features were unused.

## Open Questions

- **Version number**: `1.0.0` vs `0.6.0`.  This change defers the call to release time.  Either is acceptable provided `CHANGELOG.md` carries the BREAKING marker.
