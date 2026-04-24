## ADDED Requirements

### Requirement: send_message carries reply expectation

`send_message` SHALL accept an optional `need_reply: boolean` parameter.  When omitted, `need_reply` MUST default to `true`.  When provided, the daemon MUST persist the exact boolean value on the created `messages` row.

The `send_message` MCP tool description MUST document that private messages default to expecting a reply, and that callers can set `need_reply:false` for FYI/no-response-needed messages.

`need_reply` is a mailbox contract visible to the recipient.  It MUST NOT change delivery, auto-poke, retry, or routing behavior.

#### Scenario: send_message defaults to needing reply

- **GIVEN** agents `sess-A` and `sess-B` are in the same team
- **WHEN** `sess-A` calls `send_message({to_agent_id:'sess-B', body:'question', auto_poke:false})`
- **THEN** the created `messages` row has `need_reply=1`

#### Scenario: send_message can opt out of reply expectation

- **GIVEN** agents `sess-A` and `sess-B` are in the same team
- **WHEN** `sess-A` calls `send_message({to_agent_id:'sess-B', body:'FYI', need_reply:false, auto_poke:false})`
- **THEN** the created `messages` row has `need_reply=0`

#### Scenario: send_message description documents need_reply

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of the tool named `send_message`
- **THEN** the description string SHALL mention `need_reply`
- **AND** SHALL state that `need_reply:false` means no reply is expected

### Requirement: Fan-out messages are no-reply by default

`broadcast` and `broadcast_to_role` SHALL persist `need_reply=false` for every created `messages` row.  These tools MUST NOT accept a `need_reply` input parameter in this change.

#### Scenario: broadcast rows are marked no-reply

- **GIVEN** team `default` has agents `sess-A`, `sess-B`, and `sess-C`
- **WHEN** `sess-A` calls `broadcast({body:'all-hands', auto_poke:false})`
- **THEN** every created `messages` row has `need_reply=0`

#### Scenario: broadcast_to_role rows are marked no-reply

- **GIVEN** team `default` has two agents with role `worker`
- **WHEN** caller calls `broadcast_to_role({to_role:'worker', body:'status', auto_poke:false})`
- **THEN** every created `messages` row has `need_reply=0`

## MODIFIED Requirements

### Requirement: Messages table schema and event projection

The database SHALL contain a `messages` table: `id TEXT PRIMARY KEY`, `event_id INTEGER NOT NULL REFERENCES events(event_id)`, `from_team TEXT NOT NULL`, `to_team TEXT NOT NULL`, `from_agent_id TEXT NOT NULL`, `to_agent_id TEXT`, `to_role TEXT`, `subject TEXT`, `body TEXT NOT NULL`, `need_reply INTEGER NOT NULL DEFAULT 1`, `sent_at TEXT NOT NULL`. Every message write MUST be paired with an `events` row of `event_type='message_sent'`, and that events row's `from_team` / `to_team` MUST equal the message row's `from_team` / `to_team` respectively.

For same-team writes (`broadcast`, `broadcast_to_role`, same-team `send_message`), `from_team` MUST equal `to_team`. For cross-team `send_message`, `from_team` and `to_team` MAY differ.

#### Scenario: Sending a same-team message creates paired rows with equal team fields

- **WHEN** `send_message({to_agent_id:'sess-B', body:'hi'})` succeeds with sender in team `alpha`
- **THEN** one new row appears in `messages` with `from_team='alpha'` and `to_team='alpha'`
- **AND** exactly one new row in `events` with matching `event_id` and `from_team='alpha'`, `to_team='alpha'`

#### Scenario: Sending a cross-team message records distinct team fields

- **WHEN** `send_message({to_agent_id:'sess-B', to_team:'beta', body:'hi'})` succeeds with sender in team `alpha` and recipient `sess-B` genuinely in team `beta`
- **THEN** the new `messages` row has `from_team='alpha'`, `to_team='beta'`
- **AND** the paired `events` row has `from_team='alpha'`, `to_team='beta'`

#### Scenario: messages table exposes need_reply

- **WHEN** the daemon applies the storage schema
- **THEN** the `messages` table contains a `need_reply` column
- **AND** the column is `NOT NULL`
- **AND** the column default is `1`

### Requirement: get_inbox returns messages after cursor

`get_inbox({ since_event_id?: number = 0, limit?: number = 50 })` SHALL return messages addressed to the caller (by `to_agent_id`, or by `to_role` where the caller's role matches) with `to_team = caller.team` and `event_id > since_event_id`, ordered by `event_id` ascending, capped by `limit` (max 200). Response MUST include `{ messages, has_more, last_event_id }` where `last_event_id` is the highest returned event_id (or `since_event_id` if none). Each returned message MUST include `need_reply: boolean`.

Cross-team messages are delivered to the recipient's inbox normally, because the cross-team `send_message` writes the recipient's team as `to_team`.

#### Scenario: Initial inbox with default cursor

- **GIVEN** five messages addressed to caller (all in caller's team) with event_ids 10, 20, 30, 40, 50
- **WHEN** caller calls `get_inbox({})`
- **THEN** response contains the five messages
- **AND** `last_event_id === 50`
- **AND** `has_more === false`

#### Scenario: Cursor-based pagination has_more

- **GIVEN** 120 messages addressed to caller
- **WHEN** caller calls `get_inbox({ since_event_id: 0, limit: 50 })`
- **THEN** returned messages count is 50
- **AND** `has_more === true`

#### Scenario: Cross-team messages appear in recipient's inbox

- **GIVEN** caller `sess-B` is in team `beta`
- **AND** agent `sess-A` in team `alpha` sends `send_message({to_agent_id:'sess-B', to_team:'beta', body:'cross-team'})`, producing event id 42
- **WHEN** `sess-B` calls `get_inbox({since_event_id: 41})`
- **THEN** the response includes the message with `from_agent_id='sess-A'`, `from_team='alpha'`, `to_team='beta'`

#### Scenario: Inbox exposes reply expectation

- **GIVEN** agent `sess-A` sends `send_message({to_agent_id:'sess-B', body:'FYI', need_reply:false, auto_poke:false})`
- **WHEN** `sess-B` calls `get_inbox({since_event_id: 0})`
- **THEN** the returned message has `need_reply=false`
