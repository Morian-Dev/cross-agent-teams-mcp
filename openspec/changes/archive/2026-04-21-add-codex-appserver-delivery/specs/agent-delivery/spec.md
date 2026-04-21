## MODIFIED Requirements

### Requirement: DeliverySpec validation rejects unknown kinds at write time

Write paths, including `register_agent`, `bind_channel`, and any future MCP tool that accepts a `delivery` field, SHALL validate `DeliverySpec` and reject any `kind` outside the supported write surface.

The validator SHALL accept:

- `{ kind: 'none' }`
- `{ kind: 'claude-channel', channel_session_id: <trimmed non-empty string> }`
- `{ kind: 'codex-appserver', thread_id: <UUID>, ws_url: <ws:// or wss:// URL>, auth_token_ref?: <trimmed non-empty string> }`

The validator SHALL reject invalid inputs with `{ error: 'invalid_delivery', reason: <machine-readable reason> }`.

Supported `reason` values in this change are:

- `unknown_kind`
- `missing_channel_session_id`
- `invalid_thread_id`
- `invalid_ws_url`
- `invalid_auth_token_ref`

#### Scenario: Write validator accepts kind 'none'

- **WHEN** a write path receives `delivery={kind: 'none'}`
- **THEN** it returns `{ ok: { kind: 'none' } }`

#### Scenario: Write validator accepts kind 'claude-channel'

- **WHEN** a write path receives `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}`
- **THEN** it returns `{ ok: { kind: 'claude-channel', channel_session_id: 'csid-abc' } }`

#### Scenario: Write validator accepts kind 'codex-appserver'

- **WHEN** a write path receives `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799', auth_token_ref: 'CODEX_REMOTE_TOKEN'}`
- **THEN** it returns `{ ok: { kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799', auth_token_ref: 'CODEX_REMOTE_TOKEN' } }`

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

### Requirement: Poke dispatch routes by delivery.kind

The daemon's poke dispatcher SHALL select the backend transport based on the target agent's `delivery.kind` value, with the following routing:

- `kind === 'claude-channel'` → deliver via `ChannelWakeFanout` using `delivery.channel_session_id`, per `claude-channel-transport` spec; if no subscribed sink exists and `tmux_pane_id` is set, it MAY fall back to tmux injection.
- `kind === 'none'` → fall back to tmux injection if `tmux_pane_id` is set; otherwise fail with `no_transport_available`.
- `kind === 'codex-appserver'` → deliver via the Codex websocket dispatcher defined in `codex-appserver-transport/spec.md`; this route SHALL NOT fall back to tmux automatically.

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
