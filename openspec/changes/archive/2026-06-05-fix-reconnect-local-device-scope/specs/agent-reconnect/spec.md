## MODIFIED Requirements

### Requirement: reconnect tool recovers identity by ui_pid

The daemon SHALL expose an MCP tool `reconnect` that takes `{ ui_pid: number }` and recovers a prior `claude-code` registration by reverse-looking-up the agents table on `runtime_ui_pid`. The lookup MUST be constrained to the daemon's configured local device label (the value `resolveLocalDevice` returns from `--device` / `os.hostname()`, falling back to the literal `'local'` only when no device label is configured) and MUST order candidate rows by `last_seen_at` descending. The daemon's local device label MUST be threaded into the lookup from daemon configuration (the same value `register_agent` uses), not hardcoded. The tool is intended for the post-context-clear case where the agent no longer knows its own `(team, name)` but the Claude UI process id (`$PPID`, stored as `runtime_ui_pid`) is unchanged.

`ui_pid` MUST be a positive integer; a missing or non-positive `ui_pid` MUST be rejected at the schema layer.

#### Scenario: Single match reuses identity and returns it

- **GIVEN** a daemon whose configured local device label is `D`
- **AND** exactly one agents row on `device = D` has `runtime_ui_pid = 25079` with `(team='default', name='xats-creator')` and `agent_id='X'`
- **WHEN** a new MCP session calls `reconnect({ ui_pid: 25079 })`
- **THEN** the response is `{ ok: true, agent_id: 'X', name: 'xats-creator', team: 'default', channel_session_id: <csid> }`
- **AND** the agents table still has exactly one row for `(team='default', name='xats-creator')` (no new row, same `agent_id='X'`)
- **AND** that row's `last_seen_at` is updated to the current timestamp
- **AND** that row's `registered_at` and `last_processed_event_id` are unchanged

#### Scenario: Lookup is scoped to the daemon's configured device label

- **GIVEN** a daemon started with `--device jt` (configured local device label `jt`)
- **AND** exactly one agents row on `device = 'jt'` has `runtime_ui_pid = 25079` with `(team='default', name='xats-creator')`
- **AND** no row exists on the literal `device = 'local'`
- **WHEN** a new MCP session calls `reconnect({ ui_pid: 25079 })`
- **THEN** the `(team='default', name='xats-creator')` identity is resolved and returned (the literal `'local'` filter MUST NOT cause a miss)

#### Scenario: ui_pid is validated at the schema layer

- **WHEN** a caller invokes `reconnect({ ui_pid: 0 })` or `reconnect({})`
- **THEN** the call is rejected with a schema validation error
- **AND** no agents row is read or mutated

### Requirement: reconnect is scoped to local claude-code identities

`reconnect` SHALL only resolve identities on the daemon's configured local device label (the host the `ui_pid` is meaningful on), because `ui_pid` is a process id meaningful solely on that host. Rows on any other device label MUST NOT be matched. Codex reconnect (which is keyed on `thread_id`, not `ui_pid`) is out of scope for this tool.

#### Scenario: Rows on a different device are not matched

- **GIVEN** a daemon whose configured local device label is `D`
- **AND** an agents row with the same `runtime_ui_pid` value but `device != D`
- **WHEN** a caller invokes `reconnect({ ui_pid: <that value> })`
- **THEN** that other-device row is not considered a match
- **AND** if no row on `device = D` matches, the response indicates `need_register`
