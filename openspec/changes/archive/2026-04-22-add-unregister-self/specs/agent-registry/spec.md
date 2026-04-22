## ADDED Requirements

### Requirement: unregister_self removes the caller's current agent registration

The daemon SHALL expose an MCP tool `unregister_self({})` that only operates on the caller's currently-registered agent identity.

When invoked:

1. The caller MUST already be a registered agent; otherwise return `{ error: 'unknown_agent' }`.
2. The daemon MUST look for any task in the caller's team with `status='in_progress'` and `claimed_by=<caller agent_id>`. If any exists, it MUST return `{ error: 'tasks_in_progress', task_ids: string[] }` and leave all state unchanged.
3. Otherwise the daemon MUST, in one logical operation:
   - delete the caller's row from `agents`
   - delete the caller's rows from `contract_subscriptions`
   - release any in-memory session binding and identity claim associated with the caller, so the current MCP session is no longer treated as registered
4. The daemon MUST return `{ ok: true, team: <previous team>, name: <previous name>, agent_id: <previous agent_id> }`.
5. After success, any subsequent business tool call on the same MCP session MUST be rejected as `unknown_agent` until that session registers again.

Historical mailbox events, messages, contracts, and completed tasks MAY continue to reference the removed `agent_id` as stored text.  `unregister_self` MUST NOT rewrite historical rows.

#### Scenario: Registered caller successfully unregisters itself

- **GIVEN** agent `alice` is registered in team `default`
- **AND** `alice` has no task with `status='in_progress'` claimed by her `agent_id`
- **WHEN** `alice` invokes `unregister_self({})`
- **THEN** the response is `{ ok: true, team: 'default', name: 'alice', agent_id: <alice-agent-id> }`
- **AND** the `agents` table no longer has a row with that `agent_id`

#### Scenario: Unregistered session cannot call unregister_self

- **GIVEN** a fresh MCP session that has not called `register_agent`
- **WHEN** it invokes `unregister_self({})`
- **THEN** the response is `{ error: 'unknown_agent' }`

#### Scenario: unregister_self rejects caller with in-progress tasks

- **GIVEN** agent `alice` is registered in team `default`
- **AND** task `T1` in team `default` has `status='in_progress'` and `claimed_by=<alice-agent-id>`
- **WHEN** `alice` invokes `unregister_self({})`
- **THEN** the response is `{ error: 'tasks_in_progress', task_ids: ['T1'] }`
- **AND** the `agents` table still contains `alice`

#### Scenario: Successful unregister_self clears current session identity

- **GIVEN** agent `alice` successfully invoked `unregister_self({})` on MCP session `sess-A`
- **WHEN** the same session `sess-A` next invokes `get_inbox({})`
- **THEN** the response is `{ error: 'unknown_agent' }`

#### Scenario: Same identity can register again after unregister_self

- **GIVEN** agent `alice` in team `default` successfully invoked `unregister_self({})`
- **WHEN** a later MCP session invokes `register_agent({ model: 'opus-4-7', name: 'alice', team: 'default' })`
- **THEN** the call succeeds
- **AND** the `agents` table contains exactly one row for `(team='default', name='alice')`
