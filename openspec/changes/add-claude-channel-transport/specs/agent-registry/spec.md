## ADDED Requirements

### Requirement: Agents table includes channel_session_id column

The `agents` table SHALL include an additional nullable column `channel_session_id TEXT`.  This column stores the opaque identifier that binds the agent to a running Claude Code channel proxy; `NULL` indicates the agent has no active channel transport, in which case any poke uses tmux (if available) or fails with `no_transport_available`.

#### Scenario: Fresh database creates agents table with channel_session_id column

- **WHEN** the daemon bootstraps a fresh database
- **THEN** `PRAGMA table_info('agents')` lists a column named `channel_session_id`
- **AND** the column has type `TEXT` and `notnull = 0`
- **AND** rows inserted without providing `channel_session_id` default to `NULL`

### Requirement: register_agent accepts optional channel_session_id

`register_agent` SHALL accept an optional `channel_session_id: string` parameter.  A non-blank value (trim non-empty) MUST be persisted to the agents row.  Blank / whitespace-only values are treated as omission.  In the reuse path (existing row for `(team, name)`), omission or blank MUST preserve the previously persisted value; a non-blank value MUST overwrite.  In the create path, omission or blank MUST store `NULL`; a non-blank value MUST be stored verbatim.

#### Scenario: register_agent persists channel_session_id when provided on create

- **GIVEN** no existing row for `(default, alice)`
- **WHEN** the caller invokes `register_agent({model, role: 'backend', name: 'alice', channel_session_id: 'csid-abc'})`
- **THEN** the response is `{agent_id: <uuid>, team: 'default'}`
- **AND** the persisted row has `channel_session_id='csid-abc'`

#### Scenario: register_agent preserves channel_session_id when omitted on reuse

- **GIVEN** agent `(default, alice)` exists with `channel_session_id='csid-abc'`
- **WHEN** a new session calls `register_agent({model, role: 'backend', name: 'alice'})` (omitting channel_session_id)
- **THEN** the persisted row retains `channel_session_id='csid-abc'`

#### Scenario: register_agent overwrites channel_session_id when new value provided on reuse

- **GIVEN** agent `(default, alice)` exists with `channel_session_id='csid-old'`
- **WHEN** a session calls `register_agent({model, role: 'backend', name: 'alice', channel_session_id: 'csid-new'})`
- **THEN** the persisted row's `channel_session_id` becomes `'csid-new'`

### Requirement: list_agents returns channel_session_id field

`list_agents` response entries SHALL include a `channel_session_id: string | null` field reflecting the persisted column value.

#### Scenario: list_agents surfaces channel_session_id

- **GIVEN** team `default` has agent `alice` with `channel_session_id='csid-abc'` and agent `bob` with `channel_session_id=NULL`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `alice` has `channel_session_id: 'csid-abc'`
- **AND** the entry for `bob` has `channel_session_id: null`

## MODIFIED Requirements

### Requirement: register_agent response hints when transport identifiers missing

The daemon MUST attach a `hint: string` field to the successful `register_agent` response if and only if the caller provided neither a usable `tmux_pane_id` NOR a usable `channel_session_id`.  "Usable" means the field is a trimmed non-empty string.  If either identifier is usable, the hint MUST be suppressed.  Error envelopes MUST NEVER carry a hint.

The hint text MUST advise the caller to provide at least one of:

- `tmux_pane_id` — discoverable via `echo "$TMUX_PANE"` (or `tmux display-message -p '#{pane_id}'` as fallback)
- `channel_session_id` — produced by the ts-agent-teams channel plugin; available only when running Claude Code with the channel plugin loaded

The text SHOULD mention cross-agent poke delivery as the motivation.

#### Scenario: hint triggered when both identifiers missing

- **GIVEN** a caller invokes `register_agent({model, role, name})` with neither `tmux_pane_id` nor `channel_session_id`
- **WHEN** the call succeeds
- **THEN** the response contains a `hint` field
- **AND** the hint string mentions both `tmux_pane_id` and `channel_session_id`

#### Scenario: hint suppressed when tmux_pane_id provided alone

- **GIVEN** a caller invokes `register_agent({model, role, name, tmux_pane_id: '%42'})`
- **WHEN** the call succeeds
- **THEN** the response does NOT contain a `hint` field

#### Scenario: hint suppressed when channel_session_id provided alone

- **GIVEN** a caller invokes `register_agent({model, role, name, channel_session_id: 'csid-abc'})`
- **WHEN** the call succeeds
- **THEN** the response does NOT contain a `hint` field

#### Scenario: error envelope never includes hint

- **GIVEN** a register_agent call that fails (e.g. `agent_id_collision`)
- **WHEN** the daemon returns the error envelope
- **THEN** the response MUST NOT have a `hint` field
