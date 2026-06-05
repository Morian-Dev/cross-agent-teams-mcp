## MODIFIED Requirements

### Requirement: list_agents scoped to caller team

The `list_agents` MCP tool SHALL take `{ team?: string }` (defaults to caller's team) and return `{ agents: Array<{ agent_id, agent_type?, agent_type_name?, device, role, name, model?, tmux_pane_id?, last_seen_at, online: boolean }> }`. `online` MUST reflect process liveness via the `isAgentLive` predicate (see the "Agent liveness is process-based" Requirement), NOT a fixed `last_seen_at` recency window. Agents from other teams MUST NOT appear, but agents from every device within the resolved team SHALL appear so the caller can compose `name:device` addresses for cross-device recipients. The `name` field is always present and non-empty. The `device` field is always present and non-empty. The `tmux_pane_id` field MUST be present in every agent entry; its value is the persisted pane id (string) or `null` if unset. `agent_type_name` SHALL be `null` unless `agent_type='custom'`. The response object MUST NOT contain legacy `client` or `client_name` keys, and MUST NOT contain `remote_addr` or any user-facing `origin` field — `device` is the only namespace identifier visible to callers.

Rows with `role='__channel_proxy__'` MUST NOT appear in the response. Channel proxy rows are internal infrastructure for the `claude-channel` delivery path; they are not legitimate `send_message` recipients and have no place in the public team listing. The exclusion is unconditional — there is no opt-in flag to surface them — and applies even when the caller itself is a channel proxy. Internal lookup paths (`AgentsRepo.getById`, channel-wake fanout, delivery dispatch) are unaffected and continue to see channel proxy rows directly.

#### Scenario: Caller in team 'alpha' sees only team 'alpha' agents

- **GIVEN** agents A, B in team 'alpha' and agent C in team 'beta'
- **WHEN** a caller in team 'alpha' invokes `list_agents`
- **THEN** the response includes A and B but NOT C
- **AND** each agent entry has `agent_type` and `agent_type_name` keys (with `agent_type_name` null for non-custom agents)
- **AND** no entry has a `client` or `client_name` key

#### Scenario: list_agents returns one row per device for shared (team, name)

- **GIVEN** the caller is in team `foo` on device `host-a`
- **AND** the `agents` table contains `(device='host-a', team='foo', name='creator', role='default')` and `(device='host-b', team='foo', name='creator', role='default')`
- **WHEN** the caller calls `list_agents()` (no `team` arg)
- **THEN** the response `agents` array contains two entries with `name='creator'`
- **AND** one entry has `device='host-a'` and the other has `device='host-b'`
- **AND** neither entry contains a `remote_addr` field or an `origin` field

#### Scenario: list_agents excludes other teams across all devices

- **GIVEN** the caller is in team `foo`
- **AND** the `agents` table contains `(device='host-b', team='bar', name='creator')`
- **WHEN** the caller calls `list_agents()`
- **THEN** the `bar`-team entry MUST NOT appear, regardless of its device

#### Scenario: list_agents response includes device field on every entry

- **GIVEN** the `agents` table contains one row `(device='host-a', team='default', name='alice')`
- **WHEN** the caller in team `default` calls `list_agents()`
- **THEN** every entry in `agents[]` has a `device` field of type `string` with length ≥ 1

#### Scenario: Online flag reflects process liveness, not idle time

- **GIVEN** the daemon's local device label is `D`
- **AND** agent A on `device=D` has `runtime_ui_pid` set to a live process and `last_seen_at = now - 3 days`
- **AND** agent B on `device=D` has `runtime_ui_pid` set to a process that is no longer running
- **WHEN** `list_agents` is called
- **THEN** A's entry has `online: true` (its process is alive despite being idle for days)
- **AND** B's entry has `online: false` (its process is gone)

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

## ADDED Requirements

### Requirement: Agent liveness is process-based

The daemon SHALL determine an agent's liveness (the `online` flag) via an `isAgentLive(agent)` predicate keyed on process existence rather than a fixed `last_seen_at` recency window. The predicate resolves in order, first match wins:

1. **Local device + `runtime_ui_pid` set** → the agent is live iff that process is running (`process.kill(pid, 0)`; an `EPERM` error means the process exists and MUST be treated as live).
2. **Local device + `tmux_pane_id` set** (and no usable `runtime_ui_pid`) → the agent is live iff that pane still exists in the current tmux pane set. When tmux is unavailable, this rule does not apply and resolution falls through to rule 3.
3. **Otherwise** (remote device, or local with neither pid nor pane) → the agent is live iff `last_seen_at >= now - REACHABLE_MS`, where `REACHABLE_MS` is a day-level window (default 4 days) defined in `src/storage/agents-repo.ts`.

The legacy 5-minute `ONLINE_MS` window MUST NOT be used for the `online` flag. `isAgentLive` MUST NOT be required for message delivery — delivery (including fan-out) does not depend on liveness.

#### Scenario: Local agent with a live pid is online despite long idleness

- **GIVEN** a local-device agent with `runtime_ui_pid` pointing at a running process and `last_seen_at = now - 10 days`
- **WHEN** liveness is evaluated
- **THEN** the agent is `online: true`

#### Scenario: Local agent with a dead pid is offline

- **GIVEN** a local-device agent with `runtime_ui_pid` pointing at a process that is not running
- **WHEN** liveness is evaluated
- **THEN** the agent is `online: false`

#### Scenario: Remote agent falls back to a day-level last_seen window

- **GIVEN** a remote-device agent (the daemon cannot probe its pid) with `last_seen_at = now - 2 days` and `REACHABLE_MS = 4 days`
- **WHEN** liveness is evaluated
- **THEN** the agent is `online: true`
- **AND** the same agent with `last_seen_at = now - 5 days` evaluates to `online: false`
