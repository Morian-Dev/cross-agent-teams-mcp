## ADDED Requirements

### Requirement: Agents table includes channel_session_id column

The `agents` table SHALL include an additional nullable column `channel_session_id TEXT`.  This column stores the opaque identifier that binds the agent to a running Claude Code channel proxy; `NULL` indicates the agent has no active channel transport, in which case any poke uses tmux (if available) or fails with `no_transport_available`.  The column is written by the `bind_channel` MCP tool (see `claude-channel-transport/spec.md`), NOT by `register_agent`.

#### Scenario: Fresh database creates agents table with channel_session_id column

- **WHEN** the daemon bootstraps a fresh database
- **THEN** `PRAGMA table_info('agents')` lists a column named `channel_session_id`
- **AND** the column has type `TEXT` and `notnull = 0`
- **AND** rows inserted without providing `channel_session_id` default to `NULL`

### Requirement: list_agents returns channel_session_id field

`list_agents` response entries SHALL include a `channel_session_id: string | null` field reflecting the persisted column value (populated via `bind_channel`, not `register_agent`).

#### Scenario: list_agents surfaces channel_session_id

- **GIVEN** team `default` has agent `alice` with `channel_session_id='csid-abc'` (written via `bind_channel`) and agent `bob` with `channel_session_id=NULL`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `alice` has `channel_session_id: 'csid-abc'`
- **AND** the entry for `bob` has `channel_session_id: null`
