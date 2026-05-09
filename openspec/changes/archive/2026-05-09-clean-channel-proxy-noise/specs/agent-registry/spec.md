## MODIFIED Requirements

### Requirement: list_agents scoped to caller team

The `list_agents` MCP tool SHALL take `{ team?: string }` (defaults to caller's team) and return `{ agents: Array<{ agent_id, agent_type?, agent_type_name?, role, name, model?, tmux_pane_id?, last_seen_at, online: boolean }> }`. `online` MUST be true when `last_seen_at` is within the last 5 minutes. Agents from other teams MUST NOT appear. The `name` field is always present and non-empty. The `tmux_pane_id` field MUST be present in every agent entry; its value is the persisted pane id (string) or `null` if unset. `agent_type_name` SHALL be `null` unless `agent_type='custom'`. The response object MUST NOT contain legacy `client` or `client_name` keys.

Rows with `role='__channel_proxy__'` MUST NOT appear in the response. Channel proxy rows are internal infrastructure for the `claude-channel` delivery path; they are not legitimate `send_message` recipients and have no place in the public team listing. The exclusion is unconditional — there is no opt-in flag to surface them — and applies even when the caller itself is a channel proxy. Internal lookup paths (`AgentsRepo.getById`, channel-wake fanout, delivery dispatch) are unaffected and continue to see channel proxy rows directly.

#### Scenario: Caller in team 'alpha' sees only team 'alpha' agents

- **GIVEN** agents A, B in team 'alpha' and agent C in team 'beta'
- **WHEN** a caller in team 'alpha' invokes `list_agents`
- **THEN** the response includes A and B but NOT C
- **AND** each agent entry has `agent_type` and `agent_type_name` keys (with `agent_type_name` null for non-custom agents)
- **AND** no entry has a `client` or `client_name` key

#### Scenario: Online flag reflects last_seen_at freshness

- **GIVEN** agent A with `last_seen_at = now - 30s` and agent B with `last_seen_at = now - 10min`
- **WHEN** `list_agents` is called
- **THEN** A's entry has `online: true`
- **AND** B's entry has `online: false`

#### Scenario: Channel proxy rows are excluded from list_agents output

- **GIVEN** team `default` contains business agent `alice` (role `default`) and 50 channel proxy rows (role `__channel_proxy__`), all registered and `online: true`
- **WHEN** a caller in team `default` invokes `list_agents`
- **THEN** the response `agents` array contains exactly one entry for `alice`
- **AND** no entry has `role: '__channel_proxy__'`
- **AND** no entry has `name` matching `channel-proxy-*`

#### Scenario: A channel proxy caller does not see itself or other proxies via list_agents

- **GIVEN** team `default` contains 3 channel proxy rows including the caller proxy `P1`
- **WHEN** the proxy `P1` invokes `list_agents`
- **THEN** the response `agents` array contains no entry with `role: '__channel_proxy__'`
- **AND** P1 is not present in its own response
