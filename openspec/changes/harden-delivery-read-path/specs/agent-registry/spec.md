## MODIFIED Requirements

### Requirement: list_agents returns delivery field

`list_agents` response entries SHALL include a `delivery` field that is a public projection of the agent's internal `DeliverySpec`. The projected shape is strictly limited to the kind discriminant and, for `claude-channel`, the `channel_session_id` already exposed separately at the top level:

- For any agent, `delivery.kind` is one of the supported `DeliveryKind` values (`'none'`, `'claude-channel'`, `'codex-appserver'`).
- For `delivery.kind === 'claude-channel'`, `delivery` also includes `channel_session_id: string`.
- For all other kinds, `delivery` includes only `kind`.

Transport-specific routing fields — specifically `thread_id`, `ws_url`, and `auth_token_ref` for `codex-appserver`, and any future kind's payload — SHALL NOT appear in `list_agents` response entries. Internal callers (dispatchers, `AgentsRepo.getById`) continue to see the full `DeliverySpec`; only the MCP wire response is projected.

#### Scenario: list_agents surfaces delivery for kind 'claude-channel'

- **GIVEN** team `default` has agent `alice` with `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `alice` has `delivery: {kind: 'claude-channel', channel_session_id: 'csid-abc'}`

#### Scenario: list_agents surfaces delivery kind 'none' for agents with no channel

- **GIVEN** team `default` has agent `bob` with `delivery_kind='none'` and `delivery_payload IS NULL`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `bob` has `delivery: {kind: 'none'}`

#### Scenario: list_agents hides codex-appserver routing fields from peers

- **GIVEN** team `default` has agent `carol` with `delivery_kind='codex-appserver'` and `delivery_payload='{\"thread_id\":\"11111111-1111-4111-8111-111111111111\",\"ws_url\":\"ws://127.0.0.1:8799\",\"auth_token_ref\":\"env:TOKEN\"}'`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `carol` has `delivery.kind === 'codex-appserver'`
- **AND** the entry for `carol` has no `delivery.thread_id` field
- **AND** the entry for `carol` has no `delivery.ws_url` field
- **AND** the entry for `carol` has no `delivery.auth_token_ref` field
