## ADDED Requirements

### Requirement: Messages table schema and event projection

The database SHALL contain a `messages` table: `id TEXT PRIMARY KEY`, `event_id INTEGER NOT NULL REFERENCES events(event_id)`, `team TEXT NOT NULL`, `from_agent_id TEXT NOT NULL`, `to_agent_id TEXT`, `to_role TEXT`, `subject TEXT`, `body TEXT NOT NULL`, `sent_at TEXT NOT NULL`. Every message write MUST be paired with an `events` row of `event_type='message_sent'`.

#### Scenario: Sending a message creates paired rows

- **WHEN** `send_message({to_agent_id:'sess-B', body:'hi'})` succeeds
- **THEN** one new row appears in `messages` and exactly one new row in `events` with matching `event_id`

### Requirement: send_message requires exactly one recipient field

`send_message({to_agent_id?, to_role?, body, subject?})` MUST require either `to_agent_id` or `to_role`, but not both. If both are provided, the daemon SHALL return `{ error: 'ambiguous_recipient' }`. If neither is provided, it SHALL return `{ error: 'missing_recipient' }`.

#### Scenario: Both recipient fields given

- **WHEN** client calls `send_message({to_agent_id:'X', to_role:'frontend', body:'hi'})`
- **THEN** response is `{ error: 'ambiguous_recipient' }`

#### Scenario: No recipient field given

- **WHEN** client calls `send_message({body:'hi'})`
- **THEN** response is `{ error: 'missing_recipient' }`

### Requirement: send_message to unknown recipient

When `to_agent_id` references no agent in the caller's team, or `to_role` matches zero agents in the team, the daemon SHALL return `{ error: 'unknown_recipient' }` without writing any event.

#### Scenario: to_agent_id does not exist

- **GIVEN** no agent with id `sess-Z` exists in team 'default'
- **WHEN** caller in team 'default' calls `send_message({to_agent_id:'sess-Z', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no new event row is created

### Requirement: send_message to role fans out to all matching agents

When `to_role` is provided, the daemon SHALL materialize one `messages` row per matching agent in the caller's team, sharing a single `event_id`. The response MUST include `{ message_id, event_id, recipients: string[] }` where `recipients` is the agent_id array.

#### Scenario: Two frontend agents in team

- **GIVEN** agents `sess-F1` and `sess-F2` both have `role='frontend'` in team 'default'
- **WHEN** caller calls `send_message({to_role:'frontend', body:'hi'})`
- **THEN** `recipients` contains `['sess-F1', 'sess-F2']` (order-insensitive)
- **AND** `messages` gains two rows with identical `event_id`

### Requirement: broadcast excludes sender

`broadcast({body, subject?})` SHALL fan-out to every agent in the caller's team except the caller itself.

#### Scenario: Sender not in recipients

- **GIVEN** team 'default' has agents `sess-A`, `sess-B`, `sess-C`
- **WHEN** `sess-A` calls `broadcast({body:'all-hands'})`
- **THEN** `recipients` contains exactly `['sess-B','sess-C']`

### Requirement: get_inbox returns messages after cursor

`get_inbox({ since_event_id?: number = 0, limit?: number = 50 })` SHALL return messages addressed to the caller (by `to_agent_id`, or by `to_role` where the caller's role matches) with `event_id > since_event_id`, ordered by `event_id` ascending, capped by `limit` (max 200). Response MUST include `{ messages, has_more, last_event_id }` where `last_event_id` is the highest returned event_id (or `since_event_id` if none).

#### Scenario: Initial inbox with default cursor

- **GIVEN** five messages addressed to caller with event_ids 10, 20, 30, 40, 50
- **WHEN** caller calls `get_inbox({})`
- **THEN** response contains the five messages
- **AND** `last_event_id === 50`
- **AND** `has_more === false`

#### Scenario: Cursor-based pagination has_more

- **GIVEN** 120 messages addressed to caller
- **WHEN** caller calls `get_inbox({ since_event_id: 0, limit: 50 })`
- **THEN** returned messages count is 50
- **AND** `has_more === true`

### Requirement: Offline delivery via events outbox

Messages addressed to an agent that is currently offline SHALL be persisted in `events` and `messages` as usual. When the agent reconnects and calls `get_inbox({since_event_id: <its stored cursor>})`, it SHALL receive those messages.

#### Scenario: Message while offline, fetched after reconnect

- **GIVEN** agent `sess-A` is currently disconnected with stored cursor 5
- **WHEN** agent `sess-B` sends a message to `sess-A` creating event 6
- **AND** `sess-A` reconnects and calls `get_inbox({since_event_id: 5})`
- **THEN** the message is returned
