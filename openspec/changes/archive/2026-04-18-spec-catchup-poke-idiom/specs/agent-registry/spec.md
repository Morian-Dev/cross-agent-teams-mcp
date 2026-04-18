## MODIFIED Requirements

### Requirement: register_agent uses MCP session id as agent_id

The `register_agent` MCP tool SHALL take `{ model: string, role: string, display_name?: string, team?: string = 'default', tmux_pane_id?: string }` and use the current MCP session's UUID as the `agent_id`. It MUST return `{ agent_id, team }`. If `tmux_pane_id` is provided (a non-empty, non-whitespace string), its value MUST be persisted to the agents row's `tmux_pane_id` column. If omitted or blank, the column value MUST be NULL.

When `tmux_pane_id` is absent, empty, or whitespace-only, the response MUST additionally include an optional `hint: string` field whose value directs the caller to discover its tmux pane id (via `tmux display-message -p '#{pane_id}'`) and re-register with the result so cross-agent `poke` delivery can target this agent. When a non-blank `tmux_pane_id` is provided, the response MUST NOT include the `hint` field. On error paths (e.g. `unknown_agent`, `agent_id_collision`), the response MUST NOT include `hint`.

#### Scenario: Successful register with tmux_pane_id includes no hint field

- **GIVEN** an MCP client that calls `register_agent({ model, role, tmux_pane_id: '%42' })`
- **WHEN** the call succeeds
- **THEN** the response is `{ agent_id, team }`
- **AND** the response does NOT include a `hint` field

#### Scenario: Successful register without tmux_pane_id includes hint field

- **GIVEN** an MCP client that calls `register_agent({ model, role })` (omitting `tmux_pane_id`)
- **WHEN** the call succeeds
- **THEN** the response is `{ agent_id, team, hint: <string> }`
- **AND** the `hint` value references `tmux display-message` and `tmux_pane_id`

## ADDED Requirements

### Requirement: register_agent response hints when tmux_pane_id missing

The daemon MUST attach a `hint: string` field to the successful `register_agent` response if and only if the caller did NOT provide a usable `tmux_pane_id`.  "Not usable" means the field is (a) omitted, (b) an empty string, or (c) a string consisting only of whitespace.  A trimmed non-empty value suppresses the hint.  Error envelopes MUST NEVER carry a hint.

The hint text MUST advise the caller to run a shell command (`tmux display-message -p '#{pane_id}'`) to discover its pane id, then re-register with the result.  The text SHOULD mention cross-agent poke delivery as the motivation.

#### Scenario: Omitted tmux_pane_id triggers hint

- **GIVEN** a caller that invokes `register_agent({ model, role })` with no `tmux_pane_id` key at all
- **WHEN** the call is processed and succeeds
- **THEN** the response contains `hint: <string>`
- **AND** the hint string contains the substring `tmux_pane_id`
- **AND** the hint string contains the substring `tmux display-message`

#### Scenario: Empty string tmux_pane_id triggers hint

- **GIVEN** a caller that invokes `register_agent({ model, role, tmux_pane_id: '' })`
- **WHEN** the call is processed and succeeds
- **THEN** the response contains `hint: <string>` with the same form as the omitted case

#### Scenario: Whitespace-only tmux_pane_id triggers hint

- **GIVEN** a caller that invokes `register_agent({ model, role, tmux_pane_id: '   ' })`
- **WHEN** the call is processed and succeeds
- **THEN** the response contains `hint: <string>` with the same form as the omitted case

#### Scenario: Error envelope never includes hint

- **GIVEN** a register_agent call that fails (e.g. caller unregistered or `agent_id_collision` or any non-success path)
- **WHEN** the daemon returns the error envelope
- **THEN** the response object MUST NOT have a `hint` field
