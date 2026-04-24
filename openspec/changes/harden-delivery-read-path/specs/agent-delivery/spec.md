## MODIFIED Requirements

### Requirement: DeliverySpec persistence maps to two columns

The `agents` table SHALL persist `DeliverySpec` as two columns: `delivery_kind TEXT NOT NULL DEFAULT 'none'` and `delivery_payload TEXT NULL`, a JSON string.  The mapping is:

- `spec.kind === 'none'` → `delivery_kind='none'`, `delivery_payload=NULL`
- `spec.kind !== 'none'` → `delivery_kind=spec.kind`, `delivery_payload=JSON.stringify(rest of spec without the kind field)`

Reading a row SHALL reconstruct `DeliverySpec` by taking `delivery_kind` as `kind`. Read-side validation is symmetric to write-side validation:

- If `kind === 'none'`, the result is `{kind: 'none'}`.
- If `kind` is not one of the supported kinds (`'none'`, `'claude-channel'`, `'codex-appserver'`), reading SHALL fail with `corrupt_delivery_payload`.
- Otherwise, `delivery_payload` SHALL be parsed as JSON. If the JSON parse fails, reading SHALL fail with `corrupt_delivery_payload`.
- For `kind === 'claude-channel'`, the parsed payload SHALL contain a non-empty string `channel_session_id`. Missing or empty fails with `corrupt_delivery_payload`.
- For `kind === 'codex-appserver'`, the parsed payload SHALL contain non-empty strings `thread_id` and `ws_url`. If `auth_token_ref` is present it SHALL be a non-empty string. Any violation fails with `corrupt_delivery_payload`.

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
