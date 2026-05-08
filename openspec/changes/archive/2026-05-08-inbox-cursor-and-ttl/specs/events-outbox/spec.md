## REMOVED Requirements

### Requirement: Seven-day cleanup preserving unacked events

**Reason**: Replaced by a uniform 30-day hard cleanup that also prunes `messages` and `message_delivery_status`. The cursor-floor protection is no longer needed because (a) the new mailbox spec requires `get_inbox` to actively advance `last_processed_event_id` instead of leaving it permanently at 0, and (b) the 30-day window is treated as a forfeiture window for offline agents — any agent that has not polled in 30 days has explicitly given up the right to those rows.

**Migration**: Deployment is automatic on daemon restart. The first `runCleanup` tick after deploy MAY delete a large backlog of >30-day rows that the broken cursor-floor previously kept alive; this is intentional and matches the intended retention contract.

## MODIFIED Requirements

### Requirement: Cleanup does not touch current-state tables

The cleanup routine SHALL only operate on `events`, `messages`, and `message_delivery_status`. Rows in `agents`, `tasks`, `contracts`, `contract_subscriptions` MUST NOT be affected by age-based cleanup.

The `messages` and `message_delivery_status` tables are projections of the events outbox (each `messages` row carries `event_id REFERENCES events(event_id)` and each `message_delivery_status` row is keyed by `message_id`), so cleanup deletes them in lock-step with the underlying events to preserve referential integrity. Other current-state tables (`agents`, `tasks`, `contracts`, `contract_subscriptions`) carry no time-bounded retention contract and survive cleanup forever.

#### Scenario: Ancient contracts survive cleanup

- **GIVEN** a contract registered 60 days ago
- **WHEN** cleanup runs
- **THEN** the contract row remains in the `contracts` table

#### Scenario: Ancient agent rows survive cleanup

- **GIVEN** an agent row with `registered_at = now - 90d` and `last_seen_at = now - 90d`
- **WHEN** cleanup runs
- **THEN** the `agents` row remains

#### Scenario: Ancient tasks survive cleanup

- **GIVEN** a `tasks` row with `created_at = now - 90d` and `status='completed'`
- **WHEN** cleanup runs
- **THEN** the row remains in the `tasks` table

## ADDED Requirements

### Requirement: Thirty-day uniform cleanup of mailbox-derived tables

A cleanup routine SHALL run periodically (default every 1 hour, overridable via `CLEANUP_INTERVAL_MS`) and delete every row in `events`, `messages`, and `message_delivery_status` that satisfies a uniform 30-day age threshold:

- `messages` rows where `sent_at < now - 30d`
- `message_delivery_status` rows whose `message_id` references a `messages` row marked for deletion
- `events` rows where `created_at < now - 30d`

The deletion MUST execute as a single SQLite transaction in child-to-parent order (`message_delivery_status` → `messages` → `events`) so that no foreign-key reference is dangling at any observable point. The `runCleanup` function MUST return the total number of rows deleted across all three tables.

The 30-day threshold is hard — it MUST NOT be gated by `last_processed_event_id` of any agent, online or otherwise. Agents that have been offline for more than 30 days forfeit any unread mail.

The cleanup routine MUST NOT delete:

- Rows newer than 30 days (regardless of read status).
- Rows in tables other than the three listed above.

#### Scenario: Cleanup deletes 31-day-old rows across all three tables in one transaction

- **GIVEN** an `events` row with `event_id=42`, `created_at = now - 31d`, plus a `messages` row with `event_id=42`, `sent_at = now - 31d`, plus a `message_delivery_status` row keyed by that message
- **WHEN** `runCleanup` runs
- **THEN** all three rows are deleted
- **AND** the deletions occur in the order: `message_delivery_status` first, `messages` second, `events` last
- **AND** the call returns a non-zero `deleted` count

#### Scenario: Cleanup leaves <30-day rows intact

- **GIVEN** an `events` row with `created_at = now - 29d` plus its paired `messages` and `message_delivery_status` rows
- **WHEN** `runCleanup` runs
- **THEN** none of the three rows are deleted

#### Scenario: Cleanup ignores last_processed_event_id

- **GIVEN** all online agents in team `default` have `last_processed_event_id = 0`
- **AND** events / messages / delivery status rows older than 30 days exist
- **WHEN** `runCleanup` runs
- **THEN** those old rows are deleted regardless of any agent's cursor position

#### Scenario: Cleanup leaves agents, tasks, contracts untouched

- **GIVEN** an `agents` row with `registered_at = now - 90d`, a `tasks` row with `created_at = now - 90d`, and a `contracts` row with `registered_at = now - 90d`
- **WHEN** `runCleanup` runs
- **THEN** all three rows remain
