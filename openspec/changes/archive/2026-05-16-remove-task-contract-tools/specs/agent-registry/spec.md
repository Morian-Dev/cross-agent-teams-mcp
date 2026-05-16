## MODIFIED Requirements

### Requirement: unregister_self removes the caller's current agent registration

The daemon SHALL expose an MCP tool `unregister_self({})` that only operates on the caller's currently-registered agent identity.

When invoked:

1. The caller MUST already be a registered agent; otherwise return `{ error: 'unknown_agent' }`.
2. The daemon MUST, in one logical operation:
   - delete the caller's row from `agents`
   - release any in-memory session binding and identity claim associated with the caller, so the current MCP session is no longer treated as registered
3. The daemon MUST return `{ ok: true, team: <previous team>, name: <previous name>, agent_id: <previous agent_id> }`.
4. After success, any subsequent business tool call on the same MCP session MUST be rejected as `unknown_agent` until that session registers again.

Historical mailbox events and messages MAY continue to reference the removed `agent_id` as stored text.  `unregister_self` MUST NOT rewrite historical rows.

#### Scenario: Registered caller successfully unregisters itself

- **GIVEN** agent `alice` is registered in team `default`
- **WHEN** `alice` invokes `unregister_self({})`
- **THEN** the response is `{ ok: true, team: 'default', name: 'alice', agent_id: <alice-agent-id> }`
- **AND** the `agents` table no longer has a row with that `agent_id`

#### Scenario: Unregistered session cannot call unregister_self

- **GIVEN** a fresh MCP session that has not called `register_agent`
- **WHEN** it invokes `unregister_self({})`
- **THEN** the response is `{ error: 'unknown_agent' }`

#### Scenario: Successful unregister_self clears current session identity

- **GIVEN** agent `alice` successfully invoked `unregister_self({})` on MCP session `sess-A`
- **WHEN** the same session `sess-A` next invokes `get_inbox({})`
- **THEN** the response is `{ error: 'unknown_agent' }`

#### Scenario: Same identity can register again after unregister_self

- **GIVEN** agent `alice` in team `default` successfully invoked `unregister_self({})`
- **WHEN** a later MCP session invokes `register_agent({ agent_type: 'custom', model: 'opus-4-7', name: 'alice', team: 'default' })`
- **THEN** the call succeeds
