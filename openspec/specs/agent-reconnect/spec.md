# agent-reconnect Specification

## Purpose

Let a `claude-code` agent that has lost its `(team, name)` identity (for example after a context clear) recover its prior local registration via the stable Claude UI process id (`$PPID`, stored as `runtime_ui_pid`), reusing the existing channel and pane binding paths rather than re-registering from scratch.

## Requirements

### Requirement: reconnect tool recovers identity by ui_pid

The daemon SHALL expose an MCP tool `reconnect` that takes `{ ui_pid: number }` and recovers a prior `claude-code` registration by reverse-looking-up the agents table on `runtime_ui_pid`. The lookup MUST be constrained to `device = 'local'` and MUST order candidate rows by `last_seen_at` descending. The tool is intended for the post-context-clear case where the agent no longer knows its own `(team, name)` but the Claude UI process id (`$PPID`, stored as `runtime_ui_pid`) is unchanged.

`ui_pid` MUST be a positive integer; a missing or non-positive `ui_pid` MUST be rejected at the schema layer.

#### Scenario: Single match reuses identity and returns it

- **GIVEN** exactly one `device='local'` agents row has `runtime_ui_pid = 25079` with `(team='default', name='xats-creator')` and `agent_id='X'`
- **WHEN** a new MCP session calls `reconnect({ ui_pid: 25079 })`
- **THEN** the response is `{ ok: true, agent_id: 'X', name: 'xats-creator', team: 'default', channel_session_id: <csid> }`
- **AND** the agents table still has exactly one row for `(team='default', name='xats-creator')` (no new row, same `agent_id='X'`)
- **AND** that row's `last_seen_at` is updated to the current timestamp
- **AND** that row's `registered_at` and `last_processed_event_id` are unchanged

#### Scenario: ui_pid is validated at the schema layer

- **WHEN** a caller invokes `reconnect({ ui_pid: 0 })` or `reconnect({})`
- **THEN** the call is rejected with a schema validation error
- **AND** no agents row is read or mutated

### Requirement: reconnect performs cross-session takeover and re-binds channel and pane

On a single match, `reconnect` SHALL re-establish the identity through the same mechanisms `register_agent` uses: it MUST perform cross-session takeover (closing any prior MCP session still bound to that identity), re-bind the channel via the same `ui_pid`-driven auto-bind path, and re-bind the runtime pane via the same `ui_pid`-driven runtime-identity path. `reconnect` MUST NOT introduce new channel or pane binding logic; it reuses the existing paths.

#### Scenario: Prior session is taken over on reconnect

- **GIVEN** identity `(team='default', name='xats-creator')` is currently bound to an older MCP connection
- **WHEN** a new MCP session calls `reconnect({ ui_pid: 25079 })` matching that identity
- **THEN** the older MCP session's binding is released (cross-session takeover)
- **AND** the new MCP session becomes the active binding for `agent_id='X'`

#### Scenario: Channel session id is refreshed via ui_pid

- **GIVEN** a `__channel_proxy__` row exists for the same `ui_pid` carrying a fresh `channel_session_id`
- **WHEN** `reconnect({ ui_pid: 25079 })` succeeds
- **THEN** the matched agent's delivery is updated to the proxy's current `channel_session_id`
- **AND** the returned `channel_session_id` equals that value

### Requirement: reconnect returns need_register on zero matches

When no `device='local'` agents row matches `runtime_ui_pid = ui_pid`, `reconnect` SHALL return a `need_register` envelope that guides the caller to perform a normal `register_agent`. `reconnect` MUST NOT auto-register on a miss (single responsibility — it only reconnects existing identities).

#### Scenario: No prior identity for this ui_pid

- **GIVEN** no `device='local'` agents row has `runtime_ui_pid = 99999`
- **WHEN** a caller invokes `reconnect({ ui_pid: 99999 })`
- **THEN** the response indicates `need_register` with a human-readable reason
- **AND** no agents row is created or mutated

### Requirement: reconnect returns ambiguous candidates on multiple matches

When more than one `device='local'` agents row matches `runtime_ui_pid = ui_pid` (for example, the same UI process previously registered under two different names), `reconnect` SHALL return an `ambiguous` envelope listing the candidate identities ordered by `last_seen_at` descending, so the caller can let the user choose. `reconnect` MUST NOT silently pick one on its own.

#### Scenario: Two historical identities under one ui_pid

- **GIVEN** two `device='local'` agents rows share `runtime_ui_pid = 25079`: `(name='xats-creator', last_seen_at=T2)` and `(name='xats-tester', last_seen_at=T1)` with `T2 > T1`
- **WHEN** a caller invokes `reconnect({ ui_pid: 25079 })`
- **THEN** the response indicates `ambiguous`
- **AND** the candidate list contains both identities ordered with `xats-creator` first (most recent `last_seen_at`)
- **AND** no agents row is created or mutated

### Requirement: reconnect is scoped to local claude-code identities

`reconnect` SHALL only resolve `device='local'` identities, because `ui_pid` is a process id meaningful solely on the local host. Codex reconnect (which is keyed on `thread_id`, not `ui_pid`) is out of scope for this tool.

#### Scenario: Remote-device rows are not matched

- **GIVEN** an agents row with the same `runtime_ui_pid` value but `device != 'local'`
- **WHEN** a caller invokes `reconnect({ ui_pid: <that value> })`
- **THEN** that remote-device row is not considered a match
- **AND** if no local-device row matches, the response indicates `need_register`

### Requirement: reconnect tool description guides invocation on reconnect phrases

The `reconnect` tool's MCP description SHALL instruct the agent to invoke it when the user asks to reconnect or re-register to xats — covering at least the phrases "reconnect xats", "re-register xats", "重连 xats", and "重新注册 xats" — passing the Claude UI process id (`$PPID`) as `ui_pid`.

#### Scenario: Description lists the trigger phrases and the ui_pid source

- **WHEN** the registered `reconnect` tool's description is inspected
- **THEN** it names the reconnect/re-register trigger phrases (including the Chinese "重连 xats" / "重新注册 xats")
- **AND** it states that `ui_pid` is the Claude UI process id (`$PPID`)
