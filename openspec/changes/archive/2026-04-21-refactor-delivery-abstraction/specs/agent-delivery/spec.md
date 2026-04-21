## ADDED Requirements

### Requirement: DeliverySpec discriminated union defines the delivery channel contract

The system SHALL define a type `DeliverySpec` as a discriminated union on a literal `kind` field.  `DeliverySpec` is the single type used to represent an agent's poke delivery channel in memory, on the wire (MCP tool params / responses), and as the logical contract persisted in the `agents` table (see below).

The `kind` field SHALL be one of: `'none'`, `'claude-channel'`, `'codex-appserver'`.  The full set is closed; new kinds require a new change proposal.

Kind-specific shape:

- `{ kind: 'none' }` — no payload; indicates the agent has no configured delivery channel.  Poke attempts SHALL fall back to tmux (if `tmux_pane_id` is set) or fail with `no_transport_available`.
- `{ kind: 'claude-channel'; channel_session_id: string }` — payload is a single opaque identifier produced by a `cross-agent-teams-channel` proxy's `subscribe_channel_wake` call.  `channel_session_id` MUST be a trimmed non-empty string.
- `{ kind: 'codex-appserver'; thread_id: string; ws_url: string; auth_token_ref?: string }` — payload identifies a Codex `app-server` thread and the websocket to reach it.  `thread_id` MUST be a UUID string.  `ws_url` MUST be a `ws://` or `wss://` URL.  `auth_token_ref`, when present, MUST be a non-empty string denoting a reference (not an inline secret) that the Codex dispatcher resolves at send time; interpretation of the ref is deferred to `codex-appserver-transport` spec (out of scope for this capability).

#### Scenario: kind 'none' has no payload

- **GIVEN** a `DeliverySpec` value
- **WHEN** its `kind` is `'none'`
- **THEN** it has no other fields

#### Scenario: kind 'claude-channel' carries channel_session_id

- **GIVEN** a `DeliverySpec` value
- **WHEN** its `kind` is `'claude-channel'`
- **THEN** it has field `channel_session_id: string` and that string is trimmed non-empty

#### Scenario: kind 'codex-appserver' carries thread_id and ws_url

- **GIVEN** a `DeliverySpec` value
- **WHEN** its `kind` is `'codex-appserver'`
- **THEN** it has fields `thread_id: string` (UUID), `ws_url: string` (ws:// or wss://), and optionally `auth_token_ref: string`

### Requirement: DeliverySpec persistence maps to two columns

The `agents` table SHALL persist `DeliverySpec` as two columns: `delivery_kind TEXT NOT NULL DEFAULT 'none'` and `delivery_payload TEXT NULL` (a JSON string).  The mapping is:

- `spec.kind === 'none'` → `delivery_kind='none'`, `delivery_payload=NULL`
- `spec.kind !== 'none'` → `delivery_kind=spec.kind`, `delivery_payload=JSON.stringify(rest of spec without the kind field)`

Reading a row SHALL reconstruct `DeliverySpec` by: taking `delivery_kind` as `kind`; if `kind === 'none'`, returning `{kind: 'none'}`; otherwise parsing `delivery_payload` as JSON and merging with `{kind}`.  If `delivery_payload` fails to parse for a non-`none` kind, reading SHALL fail with `corrupt_delivery_payload`.

#### Scenario: Writing kind 'none' sets payload to NULL

- **GIVEN** a `DeliverySpec` `{kind: 'none'}`
- **WHEN** written to the `agents` row
- **THEN** `delivery_kind='none'` and `delivery_payload IS NULL`

#### Scenario: Writing kind 'claude-channel' serializes channel_session_id into payload

- **GIVEN** a `DeliverySpec` `{kind: 'claude-channel', channel_session_id: 'csid-abc'}`
- **WHEN** written to the `agents` row
- **THEN** `delivery_kind='claude-channel'` and `delivery_payload` is the JSON string `'{"channel_session_id":"csid-abc"}'`

#### Scenario: Reading back a kind 'claude-channel' row reconstructs the spec

- **GIVEN** an `agents` row with `delivery_kind='claude-channel'` and `delivery_payload='{"channel_session_id":"csid-abc"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** the result is `{kind: 'claude-channel', channel_session_id: 'csid-abc'}`

#### Scenario: Reading a non-'none' row with unparseable payload fails fast

- **GIVEN** an `agents` row with `delivery_kind='claude-channel'` and `delivery_payload='not-json'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

### Requirement: DeliverySpec validation rejects unknown kinds at write time

Write paths (register_agent, bind_channel, and any future MCP tool that accepts a `delivery` field) SHALL validate `DeliverySpec` and reject any `kind` outside the kinds currently supported by the daemon's write validator.  In this change the write validator accepts `{kind: 'none'}` and `{kind: 'claude-channel', channel_session_id: ...}` only; `codex-appserver` is defined in the type union but NOT accepted by write validators yet.

Rejection response SHALL be `{error: 'invalid_delivery'}` with a machine-readable `reason` explaining which field is missing or unsupported.

#### Scenario: Write validator accepts kind 'none'

- **WHEN** a write path receives `delivery={kind: 'none'}`
- **THEN** it accepts the input

#### Scenario: Write validator accepts kind 'claude-channel' with valid channel_session_id

- **WHEN** a write path receives `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}`
- **THEN** it accepts the input

#### Scenario: Write validator rejects kind 'codex-appserver' in this change

- **WHEN** a write path receives `delivery={kind: 'codex-appserver', thread_id: '...', ws_url: '...'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'kind_not_yet_supported'}`

#### Scenario: Write validator rejects unknown kind

- **WHEN** a write path receives `delivery={kind: 'irc'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'unknown_kind'}`

#### Scenario: Write validator rejects kind 'claude-channel' missing channel_session_id

- **WHEN** a write path receives `delivery={kind: 'claude-channel'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'missing_channel_session_id'}`

### Requirement: Poke dispatch routes by delivery.kind

The daemon's poke dispatcher SHALL select the backend transport based on the target agent's `delivery.kind` value, with the following routing:

- `kind === 'claude-channel'` → deliver via `ChannelWakeFanout` using `delivery.channel_session_id`, per `claude-channel-transport` spec.
- `kind === 'none'` → fall back to tmux injection if `tmux_pane_id` is set; otherwise fail with `no_transport_available`.
- `kind === 'codex-appserver'` → dispatcher is not implemented in this change; the daemon SHALL fail with `dispatcher_not_implemented` and log a warning.  Implementation is deferred to a separate change.

#### Scenario: Route kind 'claude-channel' to ChannelWakeFanout

- **GIVEN** target agent has `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}` and a sink attached under `csid-abc`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** the sink is invoked exactly once with the poke payload

#### Scenario: Route kind 'none' to tmux when pane is set

- **GIVEN** target agent has `delivery={kind: 'none'}` and `tmux_pane_id='%42'`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** the poke is injected via tmux to pane `%42`

#### Scenario: Route kind 'none' with no tmux returns no_transport_available

- **GIVEN** target agent has `delivery={kind: 'none'}` and `tmux_pane_id IS NULL`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** the dispatcher returns `{error: 'no_transport_available'}`

#### Scenario: kind 'codex-appserver' returns dispatcher_not_implemented in this change

- **GIVEN** target agent has `delivery={kind: 'codex-appserver', ...}`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** the dispatcher returns `{error: 'dispatcher_not_implemented'}`

### Requirement: Legacy channel_session_id access derives from delivery

While the legacy `channel_session_id` column remains on the `agents` table for backward compatibility, the daemon SHALL treat it as a read-only derived value when exposed through `AgentsRepo` and `list_agents`.  The derivation rule is:

- If `delivery.kind === 'claude-channel'`, the derived `channel_session_id` equals `delivery.channel_session_id`.
- Otherwise the derived `channel_session_id` is `null`.

No write path in this change SHALL `UPDATE agents.channel_session_id = ...`; all writes go through the `delivery_kind` / `delivery_payload` pair.

#### Scenario: derived channel_session_id for claude-channel delivery

- **GIVEN** an agent with `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}`
- **WHEN** reading the derived `channel_session_id` (via AgentsRepo or list_agents)
- **THEN** the value is `'csid-abc'`

#### Scenario: derived channel_session_id is null for other kinds

- **GIVEN** an agent with `delivery={kind: 'none'}` or `delivery={kind: 'codex-appserver', ...}`
- **WHEN** reading the derived `channel_session_id`
- **THEN** the value is `null`
