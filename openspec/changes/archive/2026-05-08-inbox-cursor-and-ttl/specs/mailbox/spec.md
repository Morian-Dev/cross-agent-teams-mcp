## MODIFIED Requirements

### Requirement: get_inbox returns messages after cursor

`get_inbox({ since_event_id?: number, limit?: number = 50 })` SHALL return messages addressed to the caller (by `to_agent_id`, or by `to_role` where the caller's role matches) with `to_team = caller.team` and `event_id > effective_since`, ordered by `event_id` ascending, capped by `limit` (max 200). Response MUST include `{ messages, has_more, last_event_id }` where `last_event_id` is the highest returned event_id (or `effective_since` if none). Each returned message MUST include `need_reply: boolean`.

The server MUST resolve `effective_since` and decide cursor advancement as follows:

1. **Argument omitted** (`since_event_id` is `undefined`): `effective_since = caller.last_processed_event_id`. After producing the response, if `last_event_id > caller.last_processed_event_id`, the daemon MUST advance the caller's row: `UPDATE agents SET last_processed_event_id = :last_event_id WHERE agent_id = :caller AND last_processed_event_id < :last_event_id`. The advance MUST happen in the same transaction as the read so that two concurrent calls cannot both see the same unread tail.
2. **Argument supplied** (any explicit number, including `0`): `effective_since = since_event_id`. The daemon MUST NOT advance the stored cursor — explicit reads are inspection / re-reads / debugging and have no side effect on `last_processed_event_id`.

Cross-team messages are delivered to the recipient's inbox normally, because the cross-team `send_message` writes the recipient's team as `to_team`.

#### Scenario: Default call advances stored cursor

- **GIVEN** caller's `last_processed_event_id = 10`
- **AND** five messages addressed to caller with event_ids 11, 12, 13, 14, 15
- **WHEN** caller calls `get_inbox({})`
- **THEN** response contains the five messages
- **AND** `last_event_id === 15`
- **AND** `has_more === false`
- **AND** the caller's `agents.last_processed_event_id` is now `15`

#### Scenario: Subsequent default call returns only newer messages

- **GIVEN** caller's `last_processed_event_id = 15` (from previous call)
- **AND** two new messages addressed to caller with event_ids 16, 17
- **WHEN** caller calls `get_inbox({})`
- **THEN** response contains exactly those two messages
- **AND** the caller's `agents.last_processed_event_id` is now `17`

#### Scenario: Default call with no new messages does not regress cursor

- **GIVEN** caller's `last_processed_event_id = 15`
- **AND** no messages addressed to caller with `event_id > 15`
- **WHEN** caller calls `get_inbox({})`
- **THEN** response is `{ messages: [], has_more: false, last_event_id: 15 }`
- **AND** the caller's `agents.last_processed_event_id` is unchanged at `15`

#### Scenario: Explicit since_event_id does not advance the stored cursor

- **GIVEN** caller's `last_processed_event_id = 50`
- **AND** messages addressed to caller with event_ids 51, 52, 53
- **WHEN** caller calls `get_inbox({ since_event_id: 0 })`
- **THEN** response contains every message addressed to caller with `event_id > 0`, including 51..53
- **AND** the caller's `agents.last_processed_event_id` is unchanged at `50`

#### Scenario: Explicit since_event_id higher than stored cursor still does not advance it

- **GIVEN** caller's `last_processed_event_id = 10`
- **AND** messages with event_ids 20, 30 addressed to caller
- **WHEN** caller calls `get_inbox({ since_event_id: 25 })`
- **THEN** response contains the message with event_id 30
- **AND** `last_event_id === 30`
- **AND** the caller's `agents.last_processed_event_id` is unchanged at `10`

#### Scenario: Cursor-based pagination has_more

- **GIVEN** caller's `last_processed_event_id = 0`
- **AND** 120 messages addressed to caller
- **WHEN** caller calls `get_inbox({ limit: 50 })`
- **THEN** returned messages count is 50
- **AND** `has_more === true`
- **AND** the caller's `agents.last_processed_event_id` is advanced to the 50th message's event_id

#### Scenario: Cross-team messages appear in recipient's inbox

- **GIVEN** caller `bob` is in team `beta` with `agent_id='uuid-B'` and `last_processed_event_id = 41`
- **AND** agent `sess-A` in team `alpha` sends `send_message({to_agent_name:'bob', to_team:'beta', body:'cross-team'})`, producing event id 42
- **WHEN** `bob` calls `get_inbox({})`
- **THEN** the response includes the message with `from_agent_id='sess-A'`, `from_team='alpha'`, `to_team='beta'`
- **AND** bob's `last_processed_event_id` is advanced to `42`

#### Scenario: Inbox exposes reply expectation

- **GIVEN** agent `sess-A` sends `send_message_by_id({to_agent_id:'sess-B', body:'FYI', need_reply:false, auto_poke:false})`
- **WHEN** `sess-B` calls `get_inbox({since_event_id: 0})`
- **THEN** the returned message has `need_reply=false`

## ADDED Requirements

### Requirement: Mailbox messages are deleted after 30-day retention window

The daemon's cleanup routine SHALL delete every row in `messages` whose `sent_at` is older than 30 days, together with the corresponding rows in `message_delivery_status` (keyed by `message_id`) and the underlying rows in `events` (keyed by `event_id`). Deletion MUST be performed in a single SQLite transaction in child-to-parent order: `message_delivery_status` → `messages` → `events`, so foreign-key references never become dangling mid-transaction.

The 30-day window applies uniformly to direct, broadcast, and broadcast-to-role messages, regardless of whether any recipient has read them. Offline agents that have not polled within 30 days forfeit the messages addressed to them; this is the explicit retention contract — agents must read on their own cadence.

The cleanup routine MUST NOT consult `last_processed_event_id` when deciding whether a message is deletable; the 30-day age threshold is the sole criterion for the message-and-events deletion path.

#### Scenario: 31-day-old message and its event are deleted

- **GIVEN** a message row with `sent_at = now - 31d` and its paired events row with `created_at = now - 31d`
- **AND** a corresponding `message_delivery_status` row for that `message_id`
- **WHEN** `runCleanup` runs
- **THEN** the `message_delivery_status` row is deleted
- **AND** the `messages` row is deleted
- **AND** the `events` row is deleted
- **AND** the deletions occur in a single transaction (child→parent ordering)

#### Scenario: 29-day-old message survives

- **GIVEN** a message row with `sent_at = now - 29d`
- **WHEN** `runCleanup` runs
- **THEN** the `messages` row remains
- **AND** the corresponding `events` row remains
- **AND** the corresponding `message_delivery_status` row remains

#### Scenario: 31-day-old broadcast deletes every recipient's row plus the shared event

- **GIVEN** a broadcast event with `event_id=42`, `created_at = now - 31d`, that produced three `messages` rows for recipients B, C, D (all with `sent_at = now - 31d`) and three `message_delivery_status` rows
- **WHEN** `runCleanup` runs
- **THEN** all three `message_delivery_status` rows are deleted
- **AND** all three `messages` rows are deleted
- **AND** the single `events` row with `event_id=42` is deleted

#### Scenario: Offline agent forfeits unread mail older than 30 days

- **GIVEN** agent A has `last_processed_event_id = 0` and `last_seen_at = now - 45d` (offline)
- **AND** a message addressed to A with `sent_at = now - 35d` and `event_id = 100`
- **WHEN** `runCleanup` runs
- **AND** then A reconnects and calls `get_inbox({})`
- **THEN** A does NOT see that message (it was deleted by the 30-day TTL)
- **AND** the response is `{ messages: [], has_more: false, last_event_id: 0 }` (assuming no other addressed messages)
