## ADDED Requirements

### Requirement: Events table schema

The SQLite database SHALL contain an `events` table with columns `event_id INTEGER PRIMARY KEY AUTOINCREMENT`, `team TEXT NOT NULL`, `event_type TEXT NOT NULL`, `actor_agent_id TEXT`, `payload TEXT NOT NULL /* JSON */`, `created_at TEXT NOT NULL /* ISO8601 */`. It MUST carry the composite index `idx_events_team_eventid (team, event_id)`.

#### Scenario: Fresh database creates events table and index

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA table_info('events')` lists the six columns with the specified types
- **AND** `PRAGMA index_list('events')` contains `idx_events_team_eventid`

### Requirement: Event append returns monotonically increasing event_id

Every call to `EventsOutbox.append({team, event_type, actor_agent_id?, payload})` SHALL return the inserted row's `event_id`. Within a single `team`, successive appends MUST return strictly increasing `event_id` values.

#### Scenario: Two appends return increasing ids

- **GIVEN** an empty events table
- **WHEN** `append({team:'default', event_type:'x', payload:{}})` is called twice
- **THEN** the second returned id is greater than the first

### Requirement: Team-scoped fan-out query

`EventsOutbox.since({team, since_event_id, limit})` SHALL return rows where `team = :team AND event_id > :since_event_id`, ordered by `event_id` ascending, capped by `limit` (default 100, max 500). It MUST NOT return rows from other teams.

#### Scenario: Cursor-based pagination within same team

- **GIVEN** events with ids 1..5 in team 'default' and 6..10 in team 'other'
- **WHEN** `since({team:'default', since_event_id:2, limit:10})` is queried
- **THEN** the returned rows have event_ids exactly [3, 4, 5]

### Requirement: Seven-day cleanup preserving unacked events

A cleanup routine SHALL delete rows whose `created_at` is older than 7 days, but MUST NOT delete any row whose `event_id` is greater than or equal to the minimum `last_processed_event_id` of online agents (per team). If no agents are online, the age threshold alone applies.

#### Scenario: Cleanup preserves events newer than online cursor

- **GIVEN** events with ids 1..100 in team 'default', all older than 7 days
- **AND** one online agent with `last_processed_event_id = 50`
- **WHEN** cleanup runs
- **THEN** events 1..49 are deleted and events 50..100 remain

#### Scenario: Cleanup with no online agents

- **GIVEN** events with ids 1..100 in team 'default', all older than 7 days
- **AND** no agents currently online (all `last_seen_at` older than 5 minutes)
- **WHEN** cleanup runs
- **THEN** all 100 events are deleted

### Requirement: Cleanup does not touch current-state tables

The cleanup routine SHALL only operate on the `events` table. Rows in `agents`, `messages`, `tasks`, `contracts`, `contract_subscriptions` MUST NOT be affected by age-based cleanup.

#### Scenario: Ancient contracts survive cleanup

- **GIVEN** a contract registered 30 days ago
- **WHEN** cleanup runs
- **THEN** the contract row remains in the `contracts` table

### Requirement: SQLite PRAGMAs on bootstrap

On first connection to the database, the daemon SHALL apply: `journal_mode=WAL`, `busy_timeout=5000`, `synchronous=NORMAL`, `foreign_keys=ON`.

#### Scenario: PRAGMAs applied after bootstrap

- **WHEN** daemon opens the database
- **THEN** `PRAGMA journal_mode` returns `wal`
- **AND** `PRAGMA busy_timeout` returns `5000`
- **AND** `PRAGMA foreign_keys` returns `1`
