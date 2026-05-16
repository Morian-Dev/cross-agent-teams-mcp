## MODIFIED Requirements

### Requirement: Events table schema

The SQLite database SHALL contain an `events` table with columns `event_id INTEGER PRIMARY KEY AUTOINCREMENT`, `from_team TEXT NOT NULL`, `to_team TEXT NOT NULL`, `event_type TEXT NOT NULL`, `actor_agent_id TEXT`, `payload TEXT NOT NULL /* JSON */`, `created_at TEXT NOT NULL /* ISO8601 */`. It MUST carry two composite indexes: `idx_events_from_team_eventid (from_team, event_id)` and `idx_events_to_team_eventid (to_team, event_id)`. It MUST NOT carry any index keyed on a single `team` column.

For all event types other than cross-team `send_message` (e.g. `agent_registered`, `broadcast` messages, `broadcast_to_role` messages, same-team `send_message`), the writer MUST set `from_team = to_team`. Only cross-team `send_message` may produce rows where `from_team != to_team`.

The set of event types written by the daemon SHALL be exactly: `agent_registered`, `message_sent` (for `send_message`, `broadcast`, `broadcast_to_role`, including the cross-team variant of `send_message`), and any infrastructure events emitted by the channel/runtime layer. The daemon MUST NOT write `contract_registered`, `task_added`, `task_claimed`, or `task_completed` events. Legacy rows of those types from prior versions MAY remain in the table until the 30-day cleanup TTL reaps them, but no consumer reads them.

#### Scenario: Fresh database creates events table with both team-scoped indexes

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA table_info('events')` lists columns including `from_team` and `to_team` (both NOT NULL), and does NOT include a plain `team` column
- **AND** `PRAGMA index_list('events')` contains both `idx_events_from_team_eventid` and `idx_events_to_team_eventid`
- **AND** `PRAGMA index_list('events')` does NOT contain `idx_events_team_eventid`

#### Scenario: Non-cross-team event must have equal from_team and to_team

- **WHEN** the daemon appends any event with `event_type != 'message_sent'`, or a `message_sent` event from `broadcast` / `broadcast_to_role` / same-team `send_message`
- **THEN** the inserted row has `from_team == to_team`

#### Scenario: Daemon never emits task or contract event types

- **GIVEN** a running daemon on the new version
- **WHEN** any MCP tool, internal job, or boot-time migration writes to the `events` table
- **THEN** no row is inserted with `event_type IN ('contract_registered', 'task_added', 'task_claimed', 'task_completed')`

### Requirement: Cleanup does not touch current-state tables

The cleanup routine SHALL only operate on `events`, `messages`, `message_delivery_status`, and `agents` rows whose `role='__channel_proxy__'`. Non-proxy `agents` rows MUST NOT be affected by age-based cleanup.

The `messages` and `message_delivery_status` tables are projections of the events outbox (each `messages` row carries `event_id REFERENCES events(event_id)` and each `message_delivery_status` row is keyed by `message_id`), so cleanup deletes them in lock-step with the underlying events to preserve referential integrity. Channel proxy rows in `agents` carry no time-bounded retention contract for business semantics; they are pure infrastructure registered by the channel proxy launcher, accumulate per Claude Code session start, and SHALL be reaped under the 30-day TTL described above. Non-proxy `agents` rows survive cleanup forever.

The cleanup contract MUST NOT enumerate the legacy `tasks`, `contracts`, or `contract_subscriptions` tables. Those tables no longer exist on the new version; on upgrade they are dropped during daemon boot (see `daemon-core`).

#### Scenario: Ancient non-proxy agent rows survive cleanup

- **GIVEN** an `agents` row with `role='default'` (or any non-`__channel_proxy__` role) and `last_seen_at = now - 90d`
- **WHEN** `runCleanup` runs
- **THEN** the row remains

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

#### Scenario: Cleanup leaves non-proxy agents untouched

- **GIVEN** a non-proxy `agents` row with `registered_at = now - 90d`
- **WHEN** `runCleanup` runs
- **THEN** the row remains
