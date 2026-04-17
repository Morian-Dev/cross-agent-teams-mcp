## ADDED Requirements

### Requirement: Contract subscriptions table

The database SHALL contain a `contract_subscriptions` table: `agent_id TEXT NOT NULL`, `team TEXT NOT NULL`, `contract_name TEXT NOT NULL`, `subscribed_at TEXT NOT NULL`, `PRIMARY KEY(agent_id, team, contract_name)`.

#### Scenario: Fresh database creates subscriptions table

- **WHEN** daemon bootstraps a fresh database
- **THEN** `contract_subscriptions` exists with the composite primary key

### Requirement: subscribe_contract upserts subscription

`subscribe_contract({ name })` SHALL insert or replace a row with the caller's `agent_id`, caller's `team`, `contract_name = name`, and `subscribed_at = now()`. Response is `{ ok: true, current_version: number | null }` where `current_version` is the latest version or `null` if the contract does not yet exist.

#### Scenario: First subscription on existing contract

- **GIVEN** contract `X` is at version 3 in caller's team
- **WHEN** caller calls `subscribe_contract({name:'X'})`
- **THEN** response is `{ ok: true, current_version: 3 }`
- **AND** a row exists in `contract_subscriptions`

#### Scenario: Subscription persists across daemon restart

- **GIVEN** caller subscribed to `X` before the daemon stopped
- **WHEN** the daemon restarts and the same agent reconnects
- **THEN** the subscription row still exists

### Requirement: pending_contract_events polling

`pending_contract_events({ since_event_id?: number = 0, limit?: number = 100 })` SHALL return events of type `contract_registered` with `event_id > since_event_id` in the caller's team, ordered by `event_id` ascending. Response is `{ events: Array<{ event_id, contract_name, version, diff?, registered_at }>, has_more, last_event_id }`.

#### Scenario: Poll returns unseen contract events

- **GIVEN** three contract_registered events in caller's team with ids 10, 20, 30
- **WHEN** caller calls `pending_contract_events({since_event_id: 15})`
- **THEN** response has two events with ids 20 and 30
- **AND** `last_event_id === 30`

#### Scenario: Empty poll result

- **GIVEN** caller's cursor equals the max event id in their team
- **WHEN** caller polls
- **THEN** response `events` is empty array and `last_event_id` equals the cursor

### Requirement: SSE channel fan-out on contract events

The daemon SHALL expose a server-side push channel on the MCP Streamable HTTP session's SSE response. When a new `contract_registered` event is appended in a team, the daemon MUST push a JSON message `{ type: 'contract_event', event_id, contract_name, version, diff?: ContractDiff }` to every live SSE session in that team that has subscribed to the contract name.

#### Scenario: Subscribed online agent receives push

- **GIVEN** agent `sess-A` is online and subscribed to contract `X` in team 'default'
- **WHEN** any agent registers `register_contract({name:'X', schema:{...}})`
- **THEN** `sess-A` receives an SSE message with `type:'contract_event'`, `contract_name:'X'`, matching version

#### Scenario: Unsubscribed online agent does not receive push

- **GIVEN** agent `sess-B` is online but has not subscribed to `X`
- **WHEN** `register_contract({name:'X'})` runs
- **THEN** `sess-B` does not receive any SSE message for `X`

#### Scenario: Offline subscriber catches up via polling after reconnect

- **GIVEN** agent `sess-C` subscribed to `X` before going offline; its stored cursor is 5
- **WHEN** 3 new `X` versions are registered while `sess-C` is offline (events 6, 7, 8)
- **AND** `sess-C` reconnects and calls `pending_contract_events({since_event_id: 5})`
- **THEN** response contains the three events

### Requirement: SSE push failure does not block writes

If pushing to any SSE session fails (client disconnected, write error), the daemon MUST NOT abort the originating tool call. The event MUST already be committed in the events table before fan-out is attempted.

#### Scenario: Push failure does not roll back event

- **GIVEN** a subscribed SSE client whose socket has been severed
- **WHEN** `register_contract({name:'X'})` is called
- **THEN** the call still returns success with a valid version
- **AND** the corresponding row in the `events` table is present
