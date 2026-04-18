# mailbox Specification

## Purpose

Deliver direct and role-based messages between agents in the same team, persisting through offline periods via the events outbox and cursor-based inbox polling.

## Requirements

### Requirement: Messages table schema and event projection

The database SHALL contain a `messages` table: `id TEXT PRIMARY KEY`, `event_id INTEGER NOT NULL REFERENCES events(event_id)`, `team TEXT NOT NULL`, `from_agent_id TEXT NOT NULL`, `to_agent_id TEXT`, `to_role TEXT`, `subject TEXT`, `body TEXT NOT NULL`, `sent_at TEXT NOT NULL`. Every message write MUST be paired with an `events` row of `event_type='message_sent'`.

#### Scenario: Sending a message creates paired rows

- **WHEN** `send_message({to_agent_id:'sess-B', body:'hi'})` succeeds
- **THEN** one new row appears in `messages` and exactly one new row in `events` with matching `event_id`

### Requirement: send_message requires exactly one recipient field

`send_message({to_agent_id?, to_role?, body, subject?})` MUST require either `to_agent_id` or `to_role`, but not both. If both are provided, the daemon SHALL return `{ error: 'ambiguous_recipient' }`. If neither is provided, it SHALL return `{ error: 'missing_recipient' }`.

`send_message` MUST NOT auto-poke the recipient(s).  The tool persists the message to the mailbox and returns; the recipient sees it on their next natural turn via `get_inbox`.  Callers MAY chain `poke({ target_agent_id, prompt })` immediately after a successful `send_message` to inject a wake-up prompt into the recipient's tmux pane when immediate attention is needed.  The `send_message` tool's MCP description SHOULD advise callers of this "fire-and-forget + optional poke follow-up" idiom.

#### Scenario: Both recipient fields given

- **WHEN** client calls `send_message({to_agent_id:'X', to_role:'frontend', body:'hi'})`
- **THEN** response is `{ error: 'ambiguous_recipient' }`

#### Scenario: No recipient field given

- **WHEN** client calls `send_message({body:'hi'})`
- **THEN** response is `{ error: 'missing_recipient' }`

#### Scenario: Successful send_message does not auto-poke recipient

- **GIVEN** recipient `sess-B` is registered in the same team with `tmux_pane_id='%99'`
- **WHEN** caller `sess-A` calls `send_message({to_agent_id:'sess-B', body:'hi'})`
- **THEN** the message is persisted to `messages` with a new `event_id`
- **AND** the daemon MUST NOT internally invoke the `poke` tool or any tmux command on pane `%99`
- **AND** the response shape is `{ message_id, event_id, recipients: [...] }` with no poke-related fields

#### Scenario: send_message tool description advises poke follow-up

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of the tool named `send_message`
- **THEN** the description string SHOULD reference the `poke` tool by name
- **AND** SHOULD indicate that poke is optional / for urgent delivery, not automatic

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

`broadcast` MUST NOT auto-poke any recipient.  A broadcast producing N messages MUST NOT trigger N poke calls; doing so would spam every pane on routine updates.  Callers MAY iterate the recipient list returned by `broadcast` (or by `list_agents`) and poke targets individually when a broadcast is genuinely urgent for them.  The `broadcast` tool's MCP description SHOULD make the per-recipient-poke convention explicit.

#### Scenario: Sender not in recipients

- **GIVEN** team 'default' has agents `sess-A`, `sess-B`, `sess-C`
- **WHEN** `sess-A` calls `broadcast({body:'all-hands'})`
- **THEN** `recipients` contains exactly `['sess-B','sess-C']`

#### Scenario: broadcast does not auto-poke any recipient

- **GIVEN** team 'default' has agents `sess-A`, `sess-B`, `sess-C`, all with `tmux_pane_id` set
- **WHEN** `sess-A` calls `broadcast({body:'all-hands'})`
- **THEN** messages are persisted for `sess-B` and `sess-C`
- **AND** the daemon MUST NOT invoke the `poke` tool or any tmux command on `sess-B`'s or `sess-C`'s panes

#### Scenario: broadcast tool description advises per-recipient poke

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of the tool named `broadcast`
- **THEN** the description string SHOULD reference the `poke` tool by name
- **AND** SHOULD indicate per-recipient or per-target iteration is the convention (no mass-poke)

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

### Requirement: Fire-and-forget delivery contract for send_message and broadcast

Both `send_message` and `broadcast` MUST follow a fire-and-forget delivery contract with four clauses:
1. The tool MUST persist to the mailbox (and event outbox) and return synchronously.
2. The tool MUST NOT invoke the `poke` tool, `tmux` CLI, or any other mechanism that actively wakes the recipient(s).
3. The tool's MCP description MUST indicate that immediate wake-up, when desired, is the caller's responsibility via an explicit `poke` follow-up.
4. Future changes MUST NOT introduce auto-poke on these tools without a new behavioral-change proposal; this is the M1 ("caller decides urgency") design position.

#### Scenario: No auto-poke on send_message regardless of recipient tmux_pane_id state

- **GIVEN** recipient `sess-B` has a valid `tmux_pane_id` registered
- **WHEN** caller `sess-A` calls `send_message({to_agent_id:'sess-B', body:'any'})`
- **THEN** no `poke` entry, no tmux-injection event, no side effect beyond mailbox persistence occurs

#### Scenario: No auto-poke on broadcast regardless of recipient tmux_pane_id states

- **GIVEN** multiple recipients, some with `tmux_pane_id` and some without
- **WHEN** the sender calls `broadcast({body:'any'})`
- **THEN** persistence happens for all recipients
- **AND** no poke/tmux side effect happens for any of them, even the ones with usable panes
