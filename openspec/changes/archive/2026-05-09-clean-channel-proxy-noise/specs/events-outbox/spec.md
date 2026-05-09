## MODIFIED Requirements

### Requirement: Thirty-day uniform cleanup of mailbox-derived tables

A cleanup routine SHALL run periodically (default every 1 hour, overridable via `CLEANUP_INTERVAL_MS`) and delete every row in `events`, `messages`, and `message_delivery_status` that satisfies a uniform 30-day age threshold:

- `messages` rows where `sent_at < now - 30d`
- `message_delivery_status` rows whose `message_id` references a `messages` row marked for deletion
- `events` rows where `created_at < now - 30d`

In addition, the same cleanup pass SHALL delete `agents` rows where `role='__channel_proxy__'` AND `last_seen_at < now - 30d`, subject to the live-reference guard defined in the "Cleanup may prune stale channel proxy rows" requirement below.

The deletion MUST execute as a single SQLite transaction in child-to-parent order (`message_delivery_status` → `messages` → `events`, with stale channel proxy `agents` rows deleted as an independent step within the same transaction) so that no foreign-key reference is dangling at any observable point. The `runCleanup` function MUST return the total number of rows deleted across all four tables.

The 30-day threshold is hard — it MUST NOT be gated by `last_processed_event_id` of any agent, online or otherwise. Agents that have been offline for more than 30 days forfeit any unread mail.

The cleanup routine MUST NOT delete:

- Rows newer than 30 days (regardless of read status).
- Rows in tables other than the four listed above (`events`, `messages`, `message_delivery_status`, `agents` filtered to `role='__channel_proxy__'`).
- Non-proxy `agents` rows (any role other than `__channel_proxy__`), regardless of age.

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

#### Scenario: Cleanup leaves non-proxy agents, tasks, contracts untouched

- **GIVEN** a non-proxy `agents` row with `registered_at = now - 90d`, a `tasks` row with `created_at = now - 90d`, and a `contracts` row with `registered_at = now - 90d`
- **WHEN** `runCleanup` runs
- **THEN** all three rows remain

### Requirement: Cleanup does not touch current-state tables

The cleanup routine SHALL only operate on `events`, `messages`, `message_delivery_status`, and `agents` rows whose `role='__channel_proxy__'`. Rows in `tasks`, `contracts`, `contract_subscriptions`, and non-proxy `agents` rows MUST NOT be affected by age-based cleanup.

The `messages` and `message_delivery_status` tables are projections of the events outbox (each `messages` row carries `event_id REFERENCES events(event_id)` and each `message_delivery_status` row is keyed by `message_id`), so cleanup deletes them in lock-step with the underlying events to preserve referential integrity. Channel proxy rows in `agents` carry no time-bounded retention contract for business semantics; they are pure infrastructure registered by the channel proxy launcher, accumulate per Claude Code session start, and SHALL be reaped under the 30-day TTL described above. Other current-state tables (`tasks`, `contracts`, `contract_subscriptions`) and non-proxy `agents` rows survive cleanup forever.

#### Scenario: Ancient contracts survive cleanup

- **GIVEN** a contract registered 60 days ago
- **WHEN** cleanup runs
- **THEN** the contract row remains

#### Scenario: Ancient non-proxy agent rows survive cleanup

- **GIVEN** an `agents` row with `role='default'` (or any non-`__channel_proxy__` role) and `last_seen_at = now - 90d`
- **WHEN** `runCleanup` runs
- **THEN** the row remains

## ADDED Requirements

### Requirement: Cleanup may prune stale channel proxy rows

The cleanup routine SHALL delete `agents` rows that satisfy ALL of the following conditions:

- `role = '__channel_proxy__'`
- `last_seen_at < now - 30d`
- The row's `agent_id` is NOT referenced as a live `channel_session_id` by any other (non-proxy) `agents` row's `delivery_payload` whose `delivery_kind = 'claude-channel'`. (The delivery payload stores the channel proxy's `channel_session_id`; pruning a referenced proxy would silently break message routing for the live host.)

Channel proxy rows that fail any of these conditions MUST be retained.

The deletion MUST occur within the same SQLite transaction as the mailbox-derived cleanup, after the `events` deletion, so that all of `runCleanup`'s deletes commit atomically.

#### Scenario: Stale unreferenced channel proxy is pruned

- **GIVEN** a channel proxy row `P` in team `default` with `last_seen_at = now - 31d`
- **AND** no other `agents` row has `delivery_kind='claude-channel'` referencing `P`'s `channel_session_id`
- **WHEN** `runCleanup` runs
- **THEN** `P` is deleted
- **AND** the call's returned `deleted` count includes the row

#### Scenario: Stale channel proxy still bound to a live host is retained

- **GIVEN** a channel proxy row `P` in team `default` with `last_seen_at = now - 90d` and `channel_session_id = 'csid-X'`
- **AND** non-proxy agent `H` in team `default` with `delivery_kind='claude-channel'` and `delivery_payload` referencing `channel_session_id='csid-X'`
- **WHEN** `runCleanup` runs
- **THEN** `P` is NOT deleted
- **AND** `H`'s `delivery` configuration remains intact

#### Scenario: Recent channel proxy is retained regardless of references

- **GIVEN** a channel proxy row with `last_seen_at = now - 1d`
- **WHEN** `runCleanup` runs
- **THEN** the row is NOT deleted

#### Scenario: Pruning happens in the same cleanup transaction

- **GIVEN** stale events, messages, delivery_status, AND stale unreferenced channel proxy rows all exist
- **WHEN** `runCleanup` runs
- **THEN** all deletions commit atomically as a single SQLite transaction
- **AND** the returned `deleted` count is the sum across `events`, `messages`, `message_delivery_status`, and pruned channel proxy rows
