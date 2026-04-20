# mailbox Delta — send-message-by-name

## MODIFIED Requirements

### Requirement: send_message is 1→1 private message only

`send_message({to_agent_id?, to_agent_name?, to_team?, subject?, body, auto_poke?})` MUST accept EITHER `to_agent_id` (UUID) OR `to_agent_name` (the target's `name` field in the `agents` table) as the recipient key, but NOT both and NOT neither. Requests containing a `to_role` parameter SHALL be rejected by the MCP tool schema layer (Zod validation) — the parameter is not defined on the tool at all.

The mutual-exclusion rule SHALL be enforced as follows:

- If neither `to_agent_id` nor `to_agent_name` is provided, the daemon SHALL return `{ error: 'missing_recipient' }`.
- If BOTH `to_agent_id` and `to_agent_name` are provided, the daemon SHALL return `{ error: 'ambiguous_recipient' }`.
- If exactly one is provided, the daemon SHALL proceed with routing (see the "send_message resolves to_agent_name" Requirement for the lookup semantics).

`send_message` MUST accept an optional `to_team` parameter. When `to_team` is omitted, the daemon SHALL default it to the caller's team. When `to_team` is provided and equals the caller's team, behavior is identical to omission. When `to_team` is provided and differs from the caller's team, the call constitutes a cross-team private message. The `to_team` default-and-equality rules apply identically whether the caller used `to_agent_id` or `to_agent_name`.

The `send_message` MCP tool description MUST state: 除非用户明确指定 `to_team`, 不要跨 team 沟通.  The description MUST also reference `broadcast_to_role` as the way to address a role, and `broadcast` as the way to reach the whole team. The description SHOULD mention `to_agent_name` as the preferred field when the caller knows the target by `(team, name)` rather than by UUID, and SHOULD note that exactly one of `to_agent_id` / `to_agent_name` must be provided.

#### Scenario: Both to_agent_id and to_agent_name given

- **WHEN** caller calls `send_message({to_agent_id:'uuid-B', to_agent_name:'bob', body:'hi'})`
- **THEN** response is `{ error: 'ambiguous_recipient' }`
- **AND** no new event row is created
- **AND** no new messages row is created

#### Scenario: Neither to_agent_id nor to_agent_name given

- **WHEN** caller calls `send_message({body:'hi'})`
- **THEN** response is `{ error: 'missing_recipient' }`
- **AND** no new event row is created

#### Scenario: Only to_agent_id given proceeds via UUID path

- **GIVEN** agent `sess-B` exists in the caller's team with `agent_id='uuid-B'`
- **WHEN** caller calls `send_message({to_agent_id:'uuid-B', body:'hi'})`
- **THEN** the message is persisted with `to_agent_id='uuid-B'`
- **AND** response `recipients` equals `['uuid-B']`

#### Scenario: Only to_agent_name given proceeds via name path

- **GIVEN** agent with `name='bob'` exists in the caller's team with `agent_id='uuid-B'`
- **WHEN** caller calls `send_message({to_agent_name:'bob', body:'hi'})`
- **THEN** the message is persisted with `to_agent_id='uuid-B'`
- **AND** response `recipients` equals `['uuid-B']`

#### Scenario: send_message tool description mentions to_agent_name

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of the tool named `send_message`
- **THEN** the description string SHALL reference `to_agent_name` as the preferred routing key when the caller knows the target by `(team, name)` rather than UUID
- **AND** SHALL indicate that exactly one of `to_agent_id` / `to_agent_name` must be provided
- **AND** SHALL retain the "除非用户明确指定 `to_team`, 不要跨 team 沟通" guardrail

### Requirement: send_message to unknown recipient

When the supplied recipient cannot be resolved, the daemon SHALL return `{ error: 'unknown_recipient' }` without writing any event. "Cannot be resolved" means:

- If the caller provided `to_agent_id`: no row in `agents` has that `agent_id`, OR the row's `team` field does not equal the resolved `to_team` (caller's team if `to_team` omitted, or the explicit `to_team` if provided).
- If the caller provided `to_agent_name`: `AgentsRepo.findByIdentity({ team: resolved_to_team, name: to_agent_name })` returns `undefined` — i.e. no row in `agents` has the matching `(team, name)` pair for the resolved team.

#### Scenario: to_agent_id does not exist

- **GIVEN** no agent with id `uuid-Z` exists
- **WHEN** caller in team 'default' calls `send_message({to_agent_id:'uuid-Z', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no new event row is created

#### Scenario: to_agent_name does not exist in resolved team

- **GIVEN** no agent with `name='ghost'` exists in team 'default'
- **WHEN** caller in team 'default' calls `send_message({to_agent_name:'ghost', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no new event row is created

#### Scenario: to_agent_name exists in caller team but explicit to_team points elsewhere

- **GIVEN** agent `bob` exists in team 'alpha' only; caller is in team 'alpha'
- **WHEN** caller calls `send_message({to_agent_name:'bob', to_team:'beta', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }` (resolved_to_team='beta' has no `bob`)
- **AND** no new event row is created

#### Scenario: to_agent_id exists but resolved to_team does not match

- **GIVEN** agent `sess-B` is in team `beta`, caller is in team `alpha`, call omits `to_team` (so resolved `to_team='alpha'`)
- **WHEN** caller calls `send_message({to_agent_id:'sess-B', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no new event row is created

## ADDED Requirements

### Requirement: send_message resolves to_agent_name via (team, name) lookup

When `send_message` is called with `to_agent_name` (and not `to_agent_id`), the daemon SHALL resolve the recipient UUID via `AgentsRepo.findByIdentity({ team: resolved_to_team, name: to_agent_name })`, where `resolved_to_team = to_team ?? caller.team`. The lookup is unambiguous because the `agents_identity_idx` UNIQUE INDEX on `(team, name)` guarantees at most one matching row.

If the lookup returns a row, the daemon SHALL proceed with the existing insert + auto-poke pipeline using the resolved `agent_id`, identical to the behaviour when the caller supplied that UUID directly as `to_agent_id`.

The `send_message` success envelope SHALL be unchanged: `{ message_id, event_id, recipients: [<resolved_uuid>], poked, poke_skip_reasons?, retry_scheduled, retry_delays_s? }`. The `recipients[]` field SHALL always contain the resolved UUID, never the name, regardless of which input path the caller used.

Cross-team sends via `to_agent_name` SHALL behave identically to cross-team sends via `to_agent_id`: the `from_team` / `to_team` values on the persisted `messages` and `events` rows reflect the resolved teams, and auto-poke fanout is not suppressed by the cross-team distinction on its own.

#### Scenario: Same-team send via to_agent_name persists and auto-pokes

- **GIVEN** agents `alice` (caller) and `bob` both in team 'default', both with `tmux_pane_id`
- **AND** bob's pane is idle, `POKE_QUIET_MS=100`
- **WHEN** alice calls `send_message({to_agent_name:'bob', body:'hi'})`
- **THEN** the message is persisted with `from_agent_id=<alice.uuid>`, `to_agent_id=<bob.uuid>`, `from_team='default'`, `to_team='default'`
- **AND** response `recipients` equals `[<bob.uuid>]`
- **AND** response `poked` is `true`
- **AND** bob's pane receives the wake-up hint

#### Scenario: Cross-team send via to_agent_name and explicit to_team

- **GIVEN** agent `alice` in team 'alpha' (caller), agent `bob` in team 'beta'
- **WHEN** alice calls `send_message({to_agent_name:'bob', to_team:'beta', body:'hi'})`
- **THEN** the message is persisted with `from_team='alpha'`, `to_team='beta'`, `to_agent_id=<bob.uuid in beta>`
- **AND** response `recipients` equals `[<bob.uuid in beta>]`

#### Scenario: Success envelope recipients is always the resolved UUID

- **GIVEN** agent `bob` in team 'default' with `agent_id='uuid-B'` and `name='bob'`
- **WHEN** caller A calls `send_message({to_agent_name:'bob', body:'hi'})`
- **AND** caller A calls `send_message({to_agent_id:'uuid-B', body:'hi'})`
- **THEN** both responses have `recipients === ['uuid-B']`

#### Scenario: Lookup is case-sensitive (byte-equal)

- **GIVEN** agent registered with `name='Bob'` in team 'default'
- **WHEN** caller calls `send_message({to_agent_name:'bob', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }` (lowercase `bob` does not match stored `Bob`)
