## Context

`xats`'s mailbox today has two coupled defects:

1. **Stateless `get_inbox`**: callers pass `since_event_id` themselves; the daemon never tracks per-agent read position. The `agents.last_processed_event_id` column exists in the schema and is read by the cleanup GC, but no production code path ever writes it. LLM agents that lose conversation context (compaction, restart, `/clear`) call `get_inbox()` with default `since=0` and re-receive the entire history.
2. **Permanently-disabled cleanup**: `runCleanup` deletes from `events` only, gated by `MIN(last_processed_event_id)` of online agents per team. Since that column is always 0, the WHERE clause is always false, so production has never deleted a single row from `events`, `messages`, or `message_delivery_status`. SQLite file growth is unbounded.

Fixing (1) without (2) would re-activate the cleanup and cause `messages` rows to outlive their `events` parent, leaving dangling `event_id` references (and worse, `PRAGMA foreign_keys=ON` would cause cleanup to fail). They have to land together.

## Goals / Non-Goals

**Goals:**
- `get_inbox()` (no args) returns only messages newer than what the caller has already seen, and remembers that decision server-side.
- New agents do not see historical mailbox traffic that pre-dates their registration.
- Existing agents that have never advanced their cursor get a one-shot bump to the current watermark, so they stop replaying history on next boot.
- `messages`, `message_delivery_status`, and `events` are pruned on a uniform 30-day window, in a single transaction with correct child→parent ordering.
- The change is database-only and behavioural — no new tables, no new MCP tools, no new schema columns.

**Non-Goals:**
- Per-message read state (Gmail-style unread count). The cursor is a single watermark; we are not building per-`(message_id, agent_id)` read flags.
- Explicit ack tool (`ack_inbox`). The auto-advance is the contract; no separate confirmation step.
- Configurable retention windows. 30 days is hard-coded by the spec; not exposed as an env var.
- Soft-delete / archive workflows. Deletion is hard.
- Message recovery / undelete after the 30-day window. Forfeited mail is gone.

## Decisions

### D1: Auto-advance on default call, no `peek` flag

**Decision**: `get_inbox({})` advances `last_processed_event_id`. `get_inbox({since_event_id: N})` (any explicit number including `0`) does NOT advance. There is no `peek: bool` parameter.

**Rationale**: The two semantics — "give me what's new" and "let me look at history" — are already cleanly distinguished by argument presence. Adding a `peek` flag would be a third dimension on top of an already-overloaded `since_event_id`, doubling the surface area of "what does this call do?" for no marginal expressiveness.

**Alternative considered**: A `peek: bool` parameter on top of the default cursor. Rejected because the explicit-`since_event_id`-doesn't-advance rule already covers every "look without committing" use case (pass `0` to dump history, pass `N` to dump from N).

**Alternative considered**: Permanent server-side cursor with explicit `ack_inbox({up_to_event_id})`. Rejected because LLM agents will forget to ack, leading to permanent re-reads — worse than the status quo.

### D2: Cursor advance happens inside the read transaction

**Decision**: The `SELECT ... LIMIT` and the `UPDATE agents SET last_processed_event_id = ... WHERE last_processed_event_id < ...` execute in the same SQLite transaction.

**Rationale**: Without the transaction, two near-simultaneous `get_inbox()` calls from the same agent (e.g. transient double-fire from the same MCP session) could both read the same tail before either advances the cursor, causing duplicate emission. The conditional `WHERE last_processed_event_id < :last_event_id` clause additionally guarantees that an out-of-order completion can't regress the cursor.

**Risk**: long-held write locks if the SELECT returns near `limit=200` rows. Mitigation: the SELECT and UPDATE are both keyed by primary index, well under millisecond on a SQLite in-process DB; the existing `messages.event_id` index makes the SELECT bounded.

### D3: Sentinel migration via `WHERE last_processed_event_id = 0` (no migrations table)

**Decision**: The one-shot cap migration runs on every `applySchema` invocation as `UPDATE agents SET last_processed_event_id = COALESCE((SELECT MAX(event_id) FROM events), 0) WHERE last_processed_event_id = 0`. No `schema_migrations` table is introduced.

**Rationale**: The project already uses "column existence" as the schema-version detector (see `migrateAgentsDeliveryColumns`, `migrateMessagesNeedReplyColumn`). The sentinel `last_processed_event_id = 0` predicate is even simpler — once `register_agent` (D4) initialises new rows above 0 and `get_inbox` (D1) advances live agents above 0, the WHERE clause matches no rows on subsequent boots. Idempotent without infrastructure.

**Alternative considered**: A `schema_migrations` table with a named entry `cap-cursor-2026-05`. Rejected as over-engineered for a one-line UPDATE that is naturally idempotent.

**Risk**: a future change that introduces a legitimate "reset cursor to 0" semantic would unintentionally re-trigger this migration on next boot. Mitigation: don't introduce such semantics; if needed, change the sentinel.

### D4: Fresh INSERT initialises `last_processed_event_id` to `MAX(event_id)`

**Decision**: When `register_agent` performs a fresh INSERT (no row exists for `(team, name)`), the new row's `last_processed_event_id` is set to `COALESCE((SELECT MAX(event_id) FROM events), 0)` inside the same transaction. Reuse path (existing row) preserves the existing cursor.

**Rationale**: A brand-new agent has no historical mail addressed to its just-generated `agent_id`. Initialising at MAX means: if anyone broadcasts to a role this new agent matches, they only see broadcasts going forward — symmetric with existing agents post-migration.

**Alternative considered**: Initialise at `0` and rely on the get_inbox auto-advance to walk forward over historical broadcasts. Rejected because role-based broadcasts addressed to `role='backend'` from a year ago would re-fire to a freshly-registered backend agent on its first `get_inbox()`. The MAX-init makes "registration time = inbox start" a clean line.

### D5: 30-day uniform TTL, no cursor-floor protection

**Decision**: `runCleanup` deletes every row in `events`, `messages`, `message_delivery_status` whose age (`created_at` / `sent_at`) exceeds 30 days. No exception based on any agent's cursor.

**Rationale**: The original cursor-floor logic existed to prevent deleting unread mail. With the cursor actually advancing, mail is "unread" only when an agent has been offline for the entire retention window — and at 30 days, that's an explicit forfeiture. Keeping the cursor-floor would mean a single offline agent indefinitely pins the entire history of its team in the database, which is exactly the unbounded-growth pathology this change is meant to fix.

**Alternative considered**: Retain the cursor-floor at a shorter window (e.g. 7d) on top of a 30d hard ceiling. Rejected because two windows multiply the test surface and the cursor-floor isn't actually doing useful work once the watermark is a real number — agents that are reading their inbox have a cursor higher than a 30d-old event anyway.

### D6: Multi-table delete in one transaction, child→parent order

**Decision**: A single SQLite transaction in `runCleanup` deletes from `message_delivery_status` first, `messages` second, `events` last. All three DELETEs use the same `cutoff = now - 30d` value computed once at the top of the call.

**Rationale**: With `PRAGMA foreign_keys=ON` (which the existing spec already requires), parent-first deletion would fail. Wrapping all three in a single transaction also means observers (other readers) never see a state where a `messages` row exists with a missing `events` row.

**Risk**: lock contention with the new `get_inbox` transaction (D2). Mitigation: cleanup runs every hour by default and is best-effort wrapped in `try/catch`; SQLite's `busy_timeout=5000` (already set in the events-outbox spec) covers the contention window.

## Risks / Trade-offs

- **[Mass deletion on first post-deploy cleanup tick]** — production currently has months of accumulated rows. The first `runCleanup` after deploy will delete a large batch in one transaction. → Mitigation: SQLite handles bulk deletes well in WAL mode (already required); the deletion is idempotent and best-effort. If it fails partially, the next tick retries. Worst case is a bigger-than-usual `data.db.wal` file for one cleanup window.
- **[Lossy default semantics]** — agent crashes between receiving the get_inbox response and processing it, the messages are now "read" from the daemon's view but unprocessed in practice. → Mitigation: explicit `since_event_id` is documented as the recovery path. This is a deliberate tradeoff: at-least-once via auto-advance is preferred over forced-ack overhead. Agents needing stronger guarantees can poll with explicit cursor management.
- **[Migration races vs. concurrent registers]** — if `applySchema` runs while a register_agent is in flight, the migration could advance a cursor on an agent whose registration just inserted at MAX. → Mitigation: `applySchema` runs at boot before the HTTP server accepts traffic, so this race is structurally impossible. Plus, both code paths are idempotent UPDATE-WHERE with strict predicates.
- **[Forfeiture surprise]** — an agent that goes offline for 35 days comes back and silently has fewer messages than it would have a week earlier. → Mitigation: the spec states this explicitly as the retention contract; documented in the get_inbox tool description. Acceptable for an inter-agent message bus; this is not durable email.

## Migration Plan

1. Land the change. No DDL migration required — only behavioural code changes plus the sentinel UPDATE in `applySchema`.
2. On daemon restart:
   - `applySchema` runs the sentinel migration; every `last_processed_event_id = 0` row gets bumped to current `MAX(event_id)`.
   - First `runCleanup` tick (within an hour) deletes the accumulated >30d backlog from all three tables.
   - First `get_inbox()` from each agent returns only post-MAX-watermark mail (likely empty for the very first call, then incremental afterwards).
3. No client-side changes required. Existing agents that pass explicit `since_event_id` continue to work unchanged (the explicit path is preserved).

**Rollback**: revert the commit; the schema is unchanged so no DDL rollback is needed. The sentinel UPDATE has already advanced cursors — those advances are not reversed, but functionally they look identical to "agents that read their mail before rollback", which is benign.
