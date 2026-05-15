## MODIFIED Requirements

### Requirement: send_message and send_message_by_id return unknown_recipient on unresolvable target

When the supplied recipient cannot be resolved, the daemon SHALL return `{ error: 'unknown_recipient' }` without writing any event. "Cannot be resolved" means:

- For `send_message_by_id({to_agent_id})`: no row in `agents` has that `agent_id`, OR the row's `team` field does not equal the caller's team (cross-team is not supported by this tool). `device` is NOT part of this check — UUIDs are globally unique and the caller's device does not constrain UUID lookup.
- For `send_message({to_agent_name, to_team?})`: `AgentsRepo.findByIdentity({ device: resolved_to_device, team: resolved_to_team, name: resolved_name })` returns `undefined` — i.e. no row in `agents` has the matching `(device, team, name)` triple — where:
  - `resolved_name` and `resolved_to_device` come from parsing `to_agent_name` per the "send_message resolves to_agent_name via (device, team, name) lookup" requirement (bare name ⇒ `(name, caller.device)`; `name:device` ⇒ `(name, device)`).
  - `resolved_to_team = to_team ?? caller.team`.

#### Scenario: send_message_by_id with non-existent id

- **GIVEN** no agent with id `uuid-Z` exists
- **WHEN** caller in team 'default' calls `send_message_by_id({to_agent_id:'uuid-Z', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no new event row is created

#### Scenario: bare to_agent_name does not exist on caller's device

- **GIVEN** the caller is on device `host-a`, team `default`
- **AND** an agent `(device='host-b', team='default', name='ghost')` exists
- **AND** no agent `(device='host-a', team='default', name='ghost')` exists
- **WHEN** the caller calls `send_message({to_agent_name:'ghost', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }` (the bare name resolved to the caller's device, where no `ghost` exists)
- **AND** no new event row is created

#### Scenario: name:device syntax does not exist on the specified device

- **GIVEN** the caller is on device `host-a`, team `default`
- **AND** no agent `(device='host-b', team='default', name='ghost')` exists
- **WHEN** the caller calls `send_message({to_agent_name:'ghost:host-b', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no new event row is created

#### Scenario: to_agent_name exists in caller team on caller device but explicit to_team points elsewhere

- **GIVEN** agent `(device='host-a', team='alpha', name='bob')` exists only; caller is on device `host-a`, team `alpha`
- **WHEN** caller calls `send_message({to_agent_name:'bob', to_team:'beta', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }` (resolved triple is `(host-a, beta, bob)`, which has no row)
- **AND** no new event row is created

#### Scenario: send_message_by_id pointing at a cross-team agent returns unknown_recipient

- **GIVEN** agent `sess-B` with `agent_id='uuid-B'` is in team `beta`, caller is in team `alpha`
- **WHEN** caller calls `send_message_by_id({to_agent_id:'uuid-B', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no new event row is created

### Requirement: send_message resolves to_agent_name via (device, team, name) lookup

When `send_message` is called with `to_agent_name`, the daemon SHALL parse the value into `(name_part, device_part)` as follows:

- If `to_agent_name` contains no `:` character, then `name_part = to_agent_name` and `device_part = caller.device` (the caller's persisted `device` value).
- If `to_agent_name` contains a `:`, split on the FIRST `:` only: `name_part = substring(0, first_colon)`, `device_part = substring(first_colon + 1)`. Both halves MUST be non-empty after the split; if either is empty, the daemon SHALL return `{ error: 'invalid_to_agent_name' }`.

The daemon SHALL then resolve the recipient UUID via `AgentsRepo.findByIdentity({ device: device_part, team: resolved_to_team, name: name_part })`, where `resolved_to_team = to_team ?? caller.team`. The lookup is unambiguous because the `agents_identity_idx` UNIQUE INDEX on `(device, team, name)` guarantees at most one matching row.

If the lookup returns a row, the daemon SHALL proceed with the existing insert + auto-poke pipeline using the resolved `agent_id`, identical to the behaviour of `send_message_by_id` with that UUID.

The `send_message` success envelope SHALL be unchanged: `{ message_id, event_id, recipients: [<resolved_uuid>], poked, poke_skip_reasons?, retry_scheduled, retry_delays_s? }`. The `recipients[]` field SHALL always contain the resolved UUID, never the name or `name:device` literal.

Cross-team sends via `to_agent_name` SHALL set `from_team` / `to_team` on the persisted `messages` and `events` rows to reflect the resolved teams; auto-poke fanout is not suppressed by the cross-team distinction on its own. The `device_part` does NOT appear on `messages` rows — message identity is by agent UUID alone, and the device-scoped lookup is purely a resolution-time concern.

#### Scenario: Same-device same-team send via bare to_agent_name persists and auto-pokes

- **GIVEN** caller `alice` is on `(device='host-a', team='default')` with `tmux_pane_id`
- **AND** `bob` is on `(device='host-a', team='default')` with `tmux_pane_id`; bob's pane is idle, `POKE_QUIET_MS=100`
- **WHEN** alice calls `send_message({to_agent_name:'bob', body:'hi'})`
- **THEN** the message is persisted with `from_agent_id=<alice.uuid>`, `to_agent_id=<bob.uuid in host-a>`, `from_team='default'`, `to_team='default'`
- **AND** response `recipients` equals `[<bob.uuid in host-a>]`
- **AND** response `poked` is `true`
- **AND** bob's pane receives the wake-up hint

#### Scenario: Cross-device same-team send via name:device

- **GIVEN** caller `alice` is on `(device='host-a', team='default')`
- **AND** `bob` is on `(device='host-b', team='default')`
- **WHEN** alice calls `send_message({to_agent_name:'bob:host-b', body:'hi'})`
- **THEN** the message is persisted with `to_agent_id=<bob.uuid in host-b>`, `from_team='default'`, `to_team='default'`
- **AND** response `recipients` equals `[<bob.uuid in host-b>]`

#### Scenario: Bare name resolves to caller's device when both devices have agents with the same name

- **GIVEN** caller `alice` is on `(device='host-a', team='default')`
- **AND** `creator` exists on both `(device='host-a', team='default')` (uuid `X`) and `(device='host-b', team='default')` (uuid `Y`)
- **WHEN** alice calls `send_message({to_agent_name:'creator', body:'hi'})`
- **THEN** response `recipients` equals `['X']` (caller's device wins)

#### Scenario: name:device crosses both team and device

- **GIVEN** caller `alice` is on `(device='host-a', team='alpha')`
- **AND** `bob` is on `(device='host-b', team='beta')`
- **WHEN** alice calls `send_message({to_agent_name:'bob:host-b', to_team:'beta', body:'hi'})`
- **THEN** the message is persisted with `from_team='alpha'`, `to_team='beta'`, `to_agent_id=<bob.uuid in (host-b, beta)>`

#### Scenario: Success envelope recipients is always the resolved UUID

- **GIVEN** agent `bob` on `(device='host-a', team='default')` with `agent_id='uuid-B'`
- **WHEN** caller A on `(device='host-a', team='default')` calls `send_message({to_agent_name:'bob', body:'hi'})`
- **AND** caller A calls `send_message_by_id({to_agent_id:'uuid-B', body:'hi'})`
- **THEN** both responses have `recipients === ['uuid-B']`

#### Scenario: Lookup is case-sensitive (byte-equal)

- **GIVEN** agent registered with `name='Bob'` on `(device='host-a', team='default')`
- **WHEN** caller on the same device/team calls `send_message({to_agent_name:'bob', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }` (lowercase `bob` does not match stored `Bob`)

#### Scenario: Empty halves around colon are rejected as invalid input

- **WHEN** the caller invokes `send_message({to_agent_name:':host-b', body:'hi'})`
- **THEN** response is `{ error: 'invalid_to_agent_name' }`

- **WHEN** the caller invokes `send_message({to_agent_name:'bob:', body:'hi'})`
- **THEN** response is `{ error: 'invalid_to_agent_name' }`

### Requirement: broadcast excludes sender

`broadcast({body, subject?, auto_poke?})` SHALL fan-out to every agent in the caller's team except the caller itself, across ALL devices that contribute agents to that team. `broadcast` MUST NOT accept any `to_team`, `to_role`, `to_agent_id`, or `to_device` parameter — it is strictly "same-team, all members except sender, every device".

For every recipient, the persisted `messages` row MUST have `from_team` and `to_team` both equal to the caller's team. The paired `events` row MUST have equal `from_team` / `to_team` values. Recipient device is irrelevant to the message rows; routing uses the recipient's `agent_id`.

#### Scenario: Sender not in recipients

- **GIVEN** team `default` has agents `sess-A`, `sess-B`, `sess-C` on `device='host-a'`
- **WHEN** `sess-A` calls `broadcast({body:'all-hands'})`
- **THEN** `recipients` contains exactly `['sess-B','sess-C']`
- **AND** all resulting messages rows have `from_team=to_team='default'`

#### Scenario: Broadcast spans every device in the caller's team

- **GIVEN** the caller is on `(device='host-a', team='default')`
- **AND** team `default` has `alice` on `device='host-a'`, `bob` on `device='host-a'`, and `creator` on `device='host-b'`
- **WHEN** the caller calls `broadcast({body:'all-hands'})`
- **THEN** `recipients` contains `['alice', 'bob', 'creator']` (order-insensitive; both same-device peers AND the cross-device `creator` are addressed)
- **AND** all resulting messages rows have `from_team=to_team='default'`

### Requirement: broadcast_to_role tool fans out to same-team role

The daemon SHALL expose an MCP tool `broadcast_to_role({to_role, body, subject?, auto_poke?})` that materializes one `messages` row per agent in the caller's team whose `role = to_role`, sharing a single `event_id`.  Sender is excluded from recipients.  The fan-out spans every device that contributes role-matching agents to the caller's team.  All rows MUST have `from_team = to_team = caller.team` and `to_role = to_role` set; `to_agent_id` is set to the specific agent id (same pattern as the paired rows produced by the removed `send_message({to_role})` behavior, just relocated).

If no agent in the caller's team matches `to_role` on any device, the daemon SHALL return `{ error: 'unknown_recipient' }` without writing any event.

`broadcast_to_role` MUST NOT accept a `to_team` parameter or a `to_device` parameter — it is strictly same-team, all-devices.  The tool's MCP description MUST explicitly state this constraint.

Auto-poke, quiet-guard, retry-backoff, parallel fan-out, and hint-only poke body requirements apply identically to `broadcast_to_role` as they do to `broadcast` (see the Broadcast and Auto-poke requirements above).

The response shape MUST be:

```
{
  message_id: string,
  event_id: number,
  recipients: string[],           // agent_id list
  poked: boolean,
  poke_skip_reasons?: Array<{agent_id, reason}>,
  retry_scheduled: boolean,
  retry_delays_s?: number[]
}
```

#### Scenario: Two role-matching agents in team receive fan-out

- **GIVEN** agents `sess-F1` and `sess-F2` both have `role='frontend'` in team `default` on `device='host-a'`, caller `sess-X` also in team `default` on `device='host-a'`
- **WHEN** `sess-X` calls `broadcast_to_role({to_role:'frontend', body:'ship status'})`
- **THEN** `recipients` contains `['sess-F1', 'sess-F2']` (order-insensitive)
- **AND** two `messages` rows appear with identical `event_id`, `from_team=to_team='default'`, `to_role='frontend'`
- **AND** `recipients` does NOT include `sess-X` even if `sess-X` also has `role='frontend'` (sender always excluded)

#### Scenario: Role fan-out spans devices in the caller's team

- **GIVEN** team `default` has `worker-A` on `device='host-a'` with `role='worker'` and `worker-B` on `device='host-b'` with `role='worker'`
- **AND** the caller is on `(device='host-a', team='default')` with `role='lead'`
- **WHEN** the caller calls `broadcast_to_role({to_role:'worker', body:'task'})`
- **THEN** `recipients` contains both `worker-A` and `worker-B` (cross-device fan-out)

#### Scenario: No matching role returns unknown_recipient

- **GIVEN** no agent in team `default` has `role='nonexistent'` on any device
- **WHEN** caller calls `broadcast_to_role({to_role:'nonexistent', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no `messages` or `events` row is written

#### Scenario: Default auto-poke on broadcast_to_role fires for all idle-pane recipients in parallel

- **GIVEN** three role=`worker` agents in same team as caller, all with `tmux_pane_id` and idle panes, `POKE_QUIET_MS=100`
- **WHEN** caller calls `broadcast_to_role({to_role:'worker', body:'task ready'})` (auto_poke omitted)
- **THEN** response has `poked: true`, `poke_skip_reasons` absent or empty, `retry_scheduled: false`
- **AND** total call duration < 400ms (parallel, not 3 × 100ms)
- **AND** each recipient's pane received the wake-up hint

#### Scenario: broadcast_to_role does not accept to_team parameter

- **WHEN** a client calls `broadcast_to_role({to_role:'x', to_team:'beta', body:'hi'})`
- **THEN** the MCP tool's Zod schema MUST reject the call with a validation error (unknown field `to_team`)

#### Scenario: broadcast_to_role does not accept to_device parameter

- **WHEN** a client calls `broadcast_to_role({to_role:'x', to_device:'host-b', body:'hi'})`
- **THEN** the MCP tool's Zod schema MUST reject the call with a validation error (unknown field `to_device`)

#### Scenario: broadcast_to_role tool description states same-team scope

- **GIVEN** client fetches `tools/list`
- **WHEN** it reads the `description` of `broadcast_to_role`
- **THEN** the description SHOULD state the tool is strictly same-team across all devices
- **AND** SHOULD reference `send_message({to_team})` as the only cross-team path (and only for 1→1)
- **AND** SHOULD describe auto-poke default, quiet-guard, and retry-backoff consistent with `broadcast`
