## MODIFIED Requirements

### Requirement: Events table schema

The SQLite database SHALL contain an `events` table with columns `event_id INTEGER PRIMARY KEY AUTOINCREMENT`, `from_team TEXT NOT NULL`, `to_team TEXT NOT NULL`, `event_type TEXT NOT NULL`, `actor_agent_id TEXT`, `payload TEXT NOT NULL /* JSON */`, `created_at TEXT NOT NULL /* ISO8601 */`. It MUST carry two composite indexes: `idx_events_from_team_eventid (from_team, event_id)` and `idx_events_to_team_eventid (to_team, event_id)`. It MUST NOT carry any index keyed on a single `team` column.

For all event types other than cross-team `send_message` (e.g. `contract_registered`, `task_added`, `task_claimed`, `task_completed`, `agent_registered`, `broadcast` messages, `broadcast_to_role` messages, same-team `send_message`), the writer MUST set `from_team = to_team`. Only cross-team `send_message` may produce rows where `from_team != to_team`.

#### Scenario: Fresh database creates events table with both team-scoped indexes

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA table_info('events')` lists columns including `from_team` and `to_team` (both NOT NULL), and does NOT include a plain `team` column
- **AND** `PRAGMA index_list('events')` contains both `idx_events_from_team_eventid` and `idx_events_to_team_eventid`
- **AND** `PRAGMA index_list('events')` does NOT contain `idx_events_team_eventid`

#### Scenario: Non-cross-team event must have equal from_team and to_team

- **WHEN** the daemon appends any event with `event_type != 'message_sent'`, or a `message_sent` event from `broadcast` / `broadcast_to_role` / same-team `send_message`
- **THEN** the inserted row has `from_team == to_team`

### Requirement: Event append returns monotonically increasing event_id

Every call to `EventsOutbox.append({from_team, to_team, event_type, actor_agent_id?, payload})` SHALL return the inserted row's `event_id`. The `from_team` and `to_team` parameters are required and MUST be strings.

Successive appends SHALL return strictly increasing `event_id` values (globally monotonic — the index is across all teams, not per-team).

#### Scenario: Two appends return increasing ids

- **GIVEN** an empty events table
- **WHEN** `append({from_team:'default', to_team:'default', event_type:'x', payload:{}})` is called twice
- **THEN** the second returned id is greater than the first

#### Scenario: Cross-team append records differing from/to teams

- **WHEN** `append({from_team:'alpha', to_team:'beta', event_type:'message_sent', actor_agent_id:'sess-A', payload:{...}})` is called
- **THEN** the inserted row has `from_team='alpha'` and `to_team='beta'`

### Requirement: Team-scoped fan-out query

`EventsOutbox.since({team, since_event_id, limit})` SHALL return rows where `to_team = :team AND event_id > :since_event_id`, ordered by `event_id` ascending, capped by `limit` (default 100, max 500). The `team` parameter filters by `to_team` — i.e. events **targeted at** the named team — because consumers are reading their inbox.

Rows where `from_team = :team` but `to_team != :team` (i.e. the team's outbound cross-team messages) MUST NOT be returned by `since({team})`.  If callers need an outbound audit view, a separate query method is expected (not required by this Requirement).

#### Scenario: Cursor-based pagination returns events targeted at the team

- **GIVEN** events: (1) `from=alpha, to=alpha`, (2) `from=alpha, to=alpha`, (3) `from=alpha, to=beta`, (4) `from=beta, to=alpha`, (5) `from=alpha, to=alpha`
- **WHEN** `since({team:'alpha', since_event_id:0, limit:10})` is queried
- **THEN** the returned rows have event_ids exactly `[1, 2, 4, 5]`
- **AND** event_id 3 (alpha's outbound to beta) is excluded

#### Scenario: since(team) does not leak events targeting other teams

- **GIVEN** events in team `beta` with ids 6..10 (all from_team=to_team='beta')
- **WHEN** `since({team:'default', since_event_id:0, limit:10})` is queried
- **THEN** the returned rows contain none of ids 6..10

### Requirement: Seven-day cleanup preserving unacked events

A cleanup routine SHALL delete rows whose `created_at` is older than 7 days, but MUST NOT delete any row whose `event_id` is greater than or equal to the minimum `last_processed_event_id` of online agents (per target team).  The agents-per-team grouping uses `to_team` (since agents read their own team's inbox via `to_team`).

If no agents of a given team are online, the age threshold alone applies to rows with that `to_team`.

#### Scenario: Cleanup preserves events newer than online cursor

- **GIVEN** events with ids 1..100 in team `default` (all `from_team=to_team='default'`), all older than 7 days
- **AND** one online agent in team `default` with `last_processed_event_id = 50`
- **WHEN** cleanup runs
- **THEN** events 1..49 are deleted and events 50..100 remain

#### Scenario: Cleanup with no online agents in a team

- **GIVEN** events with ids 1..100 targeted at team `default` (to_team='default'), all older than 7 days
- **AND** no agents of team `default` currently online (all `last_seen_at` older than 5 minutes)
- **WHEN** cleanup runs
- **THEN** all 100 events are deleted

#### Scenario: Cross-team event retention follows the to_team cursor

- **GIVEN** event with `from_team='alpha', to_team='beta'`, event_id=42, older than 7 days
- **AND** team `beta` has one online agent with `last_processed_event_id = 40` (not yet consumed event 42)
- **WHEN** cleanup runs
- **THEN** event_id=42 is preserved (to_team='beta' agent hasn't processed it)

### Requirement: Cleanup does not touch current-state tables

The cleanup routine SHALL only operate on the `events` table. Rows in `agents`, `messages`, `tasks`, `contracts`, `contract_subscriptions` MUST NOT be affected by age-based cleanup.

#### Scenario: Ancient contracts survive cleanup

- **GIVEN** a contract registered 30 days ago
- **WHEN** cleanup runs
- **THEN** the contract row remains in the `contracts` table
