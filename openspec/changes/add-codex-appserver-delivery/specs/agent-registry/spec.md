## MODIFIED Requirements

### Requirement: register_agent response hints when tmux_pane_id missing

The daemon MUST attach a `hint: string` field to the successful `register_agent` response if and only if both of the following are true:

1. The caller did NOT provide a usable `tmux_pane_id`.  "Not usable" means the field is omitted, an empty string, or a string consisting only of whitespace.
2. The caller did NOT provide a non-tmux delivery in the same call.  A provided `delivery.kind` other than `'none'`, such as `'codex-appserver'`, suppresses the hint because cross-agent poke delivery no longer depends on tmux for that caller.

Error envelopes MUST NEVER carry a hint.

The hint text MUST advise the caller to report its tmux pane id and SHOULD mention cross-agent poke delivery as the motivation.

#### Scenario: Omitted tmux_pane_id with no delivery triggers hint

- **GIVEN** a caller that invokes `register_agent({ model, name, role })` with no `tmux_pane_id` key and no `delivery`
- **WHEN** the call is processed and succeeds
- **THEN** the response contains `hint: <string>`
- **AND** the hint string contains the substring `tmux_pane_id`

#### Scenario: Empty string tmux_pane_id with delivery kind none triggers hint

- **GIVEN** a caller that invokes `register_agent({ model, name, role, tmux_pane_id: '', delivery: { kind: 'none' } })`
- **WHEN** the call is processed and succeeds
- **THEN** the response contains `hint: <string>`

#### Scenario: Non-tmux delivery suppresses hint

- **GIVEN** a caller that invokes `register_agent({ model, name, role, delivery: { kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799' } })`
- **WHEN** the call is processed and succeeds
- **THEN** the response does NOT contain a `hint` field

#### Scenario: Error envelope never includes hint

- **GIVEN** a register_agent call that fails with `invalid_delivery`
- **WHEN** the daemon returns the error envelope
- **THEN** the response object MUST NOT have a `hint` field

### Requirement: register_agent accepts optional delivery field

The `register_agent` MCP tool SHALL accept an optional `delivery: DeliverySpec` field in its input.

When omitted, the tool behaves as before and persists `delivery_kind='none'`, `delivery_payload=NULL` on insert, or leaves existing delivery untouched on an idempotent re-registration.

When provided, the tool SHALL validate it via the `agent-delivery` write validator and persist `delivery_kind` / `delivery_payload` in the same transaction that writes the identity row.

Validation failures SHALL return `{error: 'invalid_delivery', reason: ...}` without writing any row.

#### Scenario: register_agent without delivery preserves existing default behavior

- **GIVEN** a fresh MCP session calling `register_agent({team: 'default', name: 'alice', model: 'sonnet'})` with no `delivery` field
- **WHEN** the call succeeds
- **THEN** the `agents` row for alice has `delivery_kind='none'` and `delivery_payload IS NULL`

#### Scenario: register_agent with delivery kind 'claude-channel' persists both columns atomically

- **GIVEN** a caller supplies `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}` alongside identity fields
- **WHEN** the call succeeds
- **THEN** the `agents` row has both the identity fields and `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`

#### Scenario: register_agent with delivery kind 'codex-appserver' persists both columns atomically

- **GIVEN** a caller supplies `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799', auth_token_ref: 'CODEX_REMOTE_TOKEN'}` alongside identity fields
- **WHEN** the call succeeds
- **THEN** the `agents` row has `delivery_kind='codex-appserver'`
- **AND** `delivery_payload='{\"thread_id\":\"11111111-1111-4111-8111-111111111111\",\"ws_url\":\"ws://127.0.0.1:8799\",\"auth_token_ref\":\"CODEX_REMOTE_TOKEN\"}'`

#### Scenario: register_agent with invalid codex delivery rejects without inserting

- **GIVEN** a caller supplies `delivery={kind: 'codex-appserver', thread_id: 'not-a-uuid', ws_url: 'ws://127.0.0.1:8799'}` for a not-yet-registered `(team, name)`
- **WHEN** the tool validates the payload
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_thread_id'}`
- **AND** no row is inserted for that identity
