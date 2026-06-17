## MODIFIED Requirements

### Requirement: DeliverySpec discriminated union defines the delivery channel contract

The system SHALL define a type `DeliverySpec` as a discriminated union on a literal `kind` field.  `DeliverySpec` is the single type used to represent an agent's poke delivery channel in memory, on the wire (MCP tool params / responses), and as the logical contract persisted in the `agents` table.

The `kind` field SHALL be one of: `'none'`, `'claude-channel'`, `'codex-appserver'`, `'opencode-server'`.  The full set is closed; new kinds require a new change proposal.

Kind-specific shape:

- `{ kind: 'none' }` — no payload; indicates the agent has no configured delivery channel.  Poke attempts SHALL fall back to tmux (if `tmux_pane_id` is set) or fail with `no_transport_available`.
- `{ kind: 'claude-channel'; channel_session_id: string }` — payload is a single opaque identifier produced by a `cross-agent-teams-channel` proxy's `subscribe_channel_wake` call.  `channel_session_id` MUST be a trimmed non-empty string.
- `{ kind: 'codex-appserver'; thread_id: string; ws_url: string; auth_token_ref?: string }` — payload identifies a Codex `app-server` thread and the websocket to reach it.  `thread_id` MUST be a UUID string.  `ws_url` MUST be a `ws://` or `wss://` URL.  `auth_token_ref`, when present, MUST be a non-empty string denoting a reference, not an inline secret.
- `{ kind: 'opencode-server'; session_id: string; base_url: string; auth_token_ref?: string }` — payload identifies an opencode HTTP server session and the base URL to reach it.  `session_id` MUST be a trimmed non-empty string starting with `ses`.  `base_url` MUST be an `http://` or `https://` URL.  `auth_token_ref`, when present, MUST be a non-empty string denoting a reference, not an inline secret.

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

#### Scenario: kind 'opencode-server' carries session_id and base_url

- **GIVEN** a `DeliverySpec` value
- **WHEN** its `kind` is `'opencode-server'`
- **THEN** it has fields `session_id: string` (trimmed non-empty, starting with `ses`), `base_url: string` (http:// or https://), and optionally `auth_token_ref: string`

### Requirement: DeliverySpec persistence maps to two columns

The `agents` table SHALL persist `DeliverySpec` as two columns: `delivery_kind TEXT NOT NULL DEFAULT 'none'` and `delivery_payload TEXT NULL`, a JSON string.  The mapping is:

- `spec.kind === 'none'` → `delivery_kind='none'`, `delivery_payload=NULL`
- `spec.kind !== 'none'` → `delivery_kind=spec.kind`, `delivery_payload=JSON.stringify(rest of spec without the kind field)`

Reading a row SHALL reconstruct `DeliverySpec` by taking `delivery_kind` as `kind`. Read-side validation is symmetric to write-side validation:

- If `kind === 'none'`, the result is `{kind: 'none'}`.
- If `kind` is not one of the supported kinds (`'none'`, `'claude-channel'`, `'codex-appserver'`, `'opencode-server'`), reading SHALL fail with `corrupt_delivery_payload`.
- Otherwise, `delivery_payload` SHALL be parsed as JSON. If the JSON parse fails, reading SHALL fail with `corrupt_delivery_payload`.
- For `kind === 'claude-channel'`, the parsed payload SHALL contain a non-empty string `channel_session_id`. Missing or empty fails with `corrupt_delivery_payload`.
- For `kind === 'codex-appserver'`, the parsed payload SHALL contain non-empty strings `thread_id` and `ws_url`. If `auth_token_ref` is present it SHALL be a non-empty string. Any violation fails with `corrupt_delivery_payload`.
- For `kind === 'opencode-server'`, the parsed payload SHALL contain a non-empty string `session_id` (starting with `ses`) and a non-empty string `base_url`. If `auth_token_ref` is present it SHALL be a non-empty string. Any violation fails with `corrupt_delivery_payload`.

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

#### Scenario: Reading a row with unknown delivery_kind fails fast

- **GIVEN** an `agents` row with `delivery_kind='irc'` and any `delivery_payload`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

#### Scenario: Reading a claude-channel row missing channel_session_id fails fast

- **GIVEN** an `agents` row with `delivery_kind='claude-channel'` and `delivery_payload='{}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

#### Scenario: Reading a claude-channel row with empty channel_session_id fails fast

- **GIVEN** an `agents` row with `delivery_kind='claude-channel'` and `delivery_payload='{"channel_session_id":""}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

#### Scenario: Reading a codex-appserver row missing thread_id fails fast

- **GIVEN** an `agents` row with `delivery_kind='codex-appserver'` and `delivery_payload='{"ws_url":"ws://127.0.0.1:8799"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

#### Scenario: Reading a codex-appserver row missing ws_url fails fast

- **GIVEN** an `agents` row with `delivery_kind='codex-appserver'` and `delivery_payload='{"thread_id":"11111111-1111-4111-8111-111111111111"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

#### Scenario: Reading a codex-appserver row with auth_token_ref preserves optional field

- **GIVEN** an `agents` row with `delivery_kind='codex-appserver'` and `delivery_payload='{"thread_id":"11111111-1111-4111-8111-111111111111","ws_url":"wss://example/app","auth_token_ref":"env:TOKEN"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** the result is `{kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'wss://example/app', auth_token_ref: 'env:TOKEN'}`

#### Scenario: Writing kind 'opencode-server' serializes session_id and base_url into payload

- **GIVEN** a `DeliverySpec` `{kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888'}`
- **WHEN** written to the `agents` row
- **THEN** `delivery_kind='opencode-server'` and `delivery_payload` is the JSON string `'{"session_id":"ses_abc","base_url":"http://127.0.0.1:18888"}'`

#### Scenario: Reading back a kind 'opencode-server' row reconstructs the spec

- **GIVEN** an `agents` row with `delivery_kind='opencode-server'` and `delivery_payload='{"session_id":"ses_abc","base_url":"http://127.0.0.1:18888"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** the result is `{kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888'}`

#### Scenario: Reading an opencode-server row preserves optional auth_token_ref

- **GIVEN** an `agents` row with `delivery_kind='opencode-server'` and `delivery_payload='{"session_id":"ses_abc","base_url":"http://127.0.0.1:18888","auth_token_ref":"OPENCODE_SERVER_PASSWORD"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** the result is `{kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888', auth_token_ref: 'OPENCODE_SERVER_PASSWORD'}`

#### Scenario: Reading an opencode-server row missing session_id fails fast

- **GIVEN** an `agents` row with `delivery_kind='opencode-server'` and `delivery_payload='{"base_url":"http://127.0.0.1:18888"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

#### Scenario: Reading an opencode-server row with session_id not starting with 'ses' fails fast

- **GIVEN** an `agents` row with `delivery_kind='opencode-server'` and `delivery_payload='{"session_id":"abc","base_url":"http://127.0.0.1:18888"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

#### Scenario: Reading an opencode-server row missing base_url fails fast

- **GIVEN** an `agents` row with `delivery_kind='opencode-server'` and `delivery_payload='{"session_id":"ses_abc"}'`
- **WHEN** the row is read as a `DeliverySpec`
- **THEN** reading fails with `corrupt_delivery_payload`

### Requirement: DeliverySpec validation rejects unknown kinds at write time

Write paths, including `register_agent`, `bind_channel`, and any future MCP tool that accepts a `delivery` field, SHALL validate `DeliverySpec` and reject any `kind` outside the supported write surface.

The write validator SHALL accept:

- `{kind: 'none'}`
- `{kind: 'claude-channel', channel_session_id: ...}`
- `{kind: 'codex-appserver', thread_id: <UUID>, ws_url: <ws:// or wss:// URL>, auth_token_ref?: <trimmed non-empty string>}`
- `{kind: 'opencode-server', session_id: <trimmed non-empty string starting with 'ses'>, base_url: <http:// or https:// URL>, auth_token_ref?: <trimmed non-empty string>}`

The validator SHALL reject invalid inputs with `{ error: 'invalid_delivery', reason: <machine-readable reason> }`.

Supported `reason` values in this change are:

- `unknown_kind`
- `missing_channel_session_id`
- `invalid_thread_id`
- `invalid_ws_url`
- `invalid_auth_token_ref`
- `invalid_session_id`
- `invalid_base_url`

#### Scenario: Write validator accepts kind 'none'

- **WHEN** a write path receives `delivery={kind: 'none'}`
- **THEN** it returns `{ ok: { kind: 'none' } }`

#### Scenario: Write validator accepts kind 'claude-channel'

- **WHEN** a write path receives `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}`
- **THEN** it returns `{ ok: { kind: 'claude-channel', channel_session_id: 'csid-abc' } }`

#### Scenario: Write validator accepts kind 'codex-appserver'

- **WHEN** a write path receives `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799', auth_token_ref: 'CODEX_REMOTE_TOKEN'}`
- **THEN** it returns `{ ok: { kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799', auth_token_ref: 'CODEX_REMOTE_TOKEN' } }`

#### Scenario: Write validator accepts kind 'opencode-server'

- **WHEN** a write path receives `delivery={kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888', auth_token_ref: 'OPENCODE_SERVER_PASSWORD'}`
- **THEN** it returns `{ ok: { kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888', auth_token_ref: 'OPENCODE_SERVER_PASSWORD' } }`

#### Scenario: Write validator rejects unknown kind

- **WHEN** a write path receives `delivery={kind: 'irc'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'unknown_kind'}`

#### Scenario: Write validator rejects kind 'claude-channel' missing channel_session_id

- **WHEN** a write path receives `delivery={kind: 'claude-channel'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'missing_channel_session_id'}`

#### Scenario: Write validator rejects kind 'codex-appserver' with invalid thread_id

- **WHEN** a write path receives `delivery={kind: 'codex-appserver', thread_id: 'not-a-uuid', ws_url: 'ws://127.0.0.1:8799'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_thread_id'}`

#### Scenario: Write validator rejects kind 'codex-appserver' with invalid ws_url

- **WHEN** a write path receives `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'http://127.0.0.1:8799'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_ws_url'}`

#### Scenario: Write validator rejects kind 'codex-appserver' with blank auth_token_ref

- **WHEN** a write path receives `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799', auth_token_ref: '   '}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_auth_token_ref'}`

#### Scenario: Write validator rejects kind 'opencode-server' with invalid session_id (not starting 'ses')

- **WHEN** a write path receives `delivery={kind: 'opencode-server', session_id: 'abc', base_url: 'http://127.0.0.1:18888'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_session_id'}`

#### Scenario: Write validator rejects kind 'opencode-server' with empty session_id

- **WHEN** a write path receives `delivery={kind: 'opencode-server', session_id: '', base_url: 'http://127.0.0.1:18888'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_session_id'}`

#### Scenario: Write validator rejects kind 'opencode-server' with invalid base_url

- **WHEN** a write path receives `delivery={kind: 'opencode-server', session_id: 'ses_abc', base_url: 'not-a-url'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_base_url'}`

#### Scenario: Write validator rejects kind 'opencode-server' with ws:// base_url

- **WHEN** a write path receives `delivery={kind: 'opencode-server', session_id: 'ses_abc', base_url: 'ws://127.0.0.1:18888'}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_base_url'}`

#### Scenario: Write validator rejects kind 'opencode-server' with blank auth_token_ref

- **WHEN** a write path receives `delivery={kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888', auth_token_ref: '   '}`
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_auth_token_ref'}`

### Requirement: Poke dispatch routes by delivery.kind

The daemon's poke dispatcher SHALL select the backend transport based on the target agent's `delivery.kind` value, with the following routing:

- `kind === 'claude-channel'` → deliver via `ChannelWakeFanout` using `delivery.channel_session_id`, per `claude-channel-transport` spec; if no subscribed sink exists and `tmux_pane_id` is set, it MAY fall back to tmux injection.
- `kind === 'none'` → fall back to tmux injection if `tmux_pane_id` is set; otherwise fail with `no_transport_available`.
- `kind === 'codex-appserver'` → deliver via the Codex websocket dispatcher defined in `codex-appserver-transport/spec.md`; this route SHALL NOT fall back to tmux automatically.
- `kind === 'opencode-server'` → deliver via the opencode HTTP dispatcher defined in `opencode-server-transport/spec.md`; this route SHALL NOT fall back to tmux automatically.

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

#### Scenario: Route kind 'codex-appserver' to Codex dispatcher

- **GIVEN** target agent has `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799'}`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** it invokes the Codex dispatcher with that `thread_id` and `ws_url`

#### Scenario: Codex dispatcher failure is returned without tmux fallback

- **GIVEN** target agent has `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799'}`
- **AND** the Codex dispatcher fails with `{ error: 'codex_connect_failed', detail: 'ECONNREFUSED' }`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** the daemon returns `{ error: 'codex_connect_failed', detail: 'ECONNREFUSED' }`
- **AND** it does NOT attempt tmux injection automatically

#### Scenario: Route kind 'opencode-server' to opencode dispatcher

- **GIVEN** target agent has `delivery={kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888'}`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** it invokes the opencode dispatcher with that `session_id` and `base_url`

#### Scenario: opencode dispatcher failure is returned without tmux fallback

- **GIVEN** target agent has `delivery={kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888'}`
- **AND** the opencode dispatcher fails with `{ error: 'opencode_connect_failed', detail: 'ECONNREFUSED' }`
- **WHEN** the daemon dispatches a poke to this agent
- **THEN** the daemon returns `{ error: 'opencode_connect_failed', detail: 'ECONNREFUSED' }`
- **AND** it does NOT attempt tmux injection automatically
