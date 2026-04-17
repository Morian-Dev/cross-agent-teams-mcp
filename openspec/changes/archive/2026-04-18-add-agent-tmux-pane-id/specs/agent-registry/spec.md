## MODIFIED Requirements

### Requirement: Agents table schema

The database SHALL contain an `agents` table with columns: `agent_id TEXT PRIMARY KEY`, `team TEXT NOT NULL`, `role TEXT NOT NULL`, `display_name TEXT`, `model TEXT`, `registered_at TEXT NOT NULL`, `last_seen_at TEXT NOT NULL`, `last_processed_event_id INTEGER NOT NULL DEFAULT 0`, `tmux_pane_id TEXT`.

The `tmux_pane_id` column is nullable and stores an optional tmux pane identifier (e.g. `%42`) used by cross-session interrupt delivery features (see Requirement "Tmux pane id persistence").

#### Scenario: Fresh database creates agents table with nine columns

- **WHEN** daemon bootstraps a fresh database
- **THEN** `PRAGMA table_info('agents')` lists nine columns
- **AND** the `tmux_pane_id` column exists with type `TEXT` and `notnull = 0`

#### Scenario: Legacy database auto-migrates by adding tmux_pane_id column

- **GIVEN** a pre-existing agents table without `tmux_pane_id` column (built under an older schema)
- **WHEN** daemon bootstraps against this database
- **THEN** `ALTER TABLE agents ADD COLUMN tmux_pane_id TEXT` is executed exactly once
- **AND** existing rows' `tmux_pane_id` values are NULL
- **AND** subsequent boots detect the column present and do not re-run the ALTER

### Requirement: register_agent uses MCP session id as agent_id

The `register_agent` MCP tool SHALL take `{ model: string, role: string, display_name?: string, team?: string = 'default', tmux_pane_id?: string }` and use the current MCP session's UUID as the `agent_id`. It MUST return `{ agent_id, team }`. If `tmux_pane_id` is provided, its value MUST be persisted to the agents row's `tmux_pane_id` column. If omitted, the column value MUST be NULL.

#### Scenario: New session registers with tmux_pane_id provided

- **GIVEN** an MCP client with a fresh session id `sess-A` running in tmux pane `%42`
- **WHEN** it calls `register_agent({ model: 'opus-4-7', role: 'frontend', tmux_pane_id: '%42' })`
- **THEN** response is `{ agent_id: 'sess-A', team: 'default' }`
- **AND** the agents row for `sess-A` has `tmux_pane_id = '%42'`

#### Scenario: New session registers without tmux_pane_id

- **GIVEN** an MCP client not running inside tmux (or not reporting pane id)
- **WHEN** it calls `register_agent({ model: 'opus-4-7', role: 'cron' })`
- **THEN** the call succeeds
- **AND** the agents row for the session has `tmux_pane_id IS NULL`

### Requirement: Repeated register_agent within same session updates metadata

If the same MCP session calls `register_agent` multiple times, the daemon SHALL upsert (update) the metadata — including `tmux_pane_id` when provided — without treating it as a conflict.

#### Scenario: Same session re-registers with new tmux_pane_id

- **GIVEN** session `sess-A` has previously registered with `tmux_pane_id = '%42'`
- **WHEN** the same session calls `register_agent({ model: 'opus-4-7', role: 'frontend', tmux_pane_id: '%99' })`
- **THEN** the call succeeds
- **AND** the agents row's `tmux_pane_id` becomes `'%99'`

#### Scenario: Same session re-registers omitting tmux_pane_id does not clear existing value

- **GIVEN** session `sess-A` has previously registered with `tmux_pane_id = '%42'`
- **WHEN** the same session calls `register_agent({ model: 'opus-4-7', role: 'frontend' })` (no `tmux_pane_id`)
- **THEN** the call succeeds
- **AND** the agents row's `tmux_pane_id` remains `'%42'` (omitted field means "no change", not "clear")

### Requirement: list_agents scoped to caller team

The `list_agents` MCP tool SHALL take `{ team?: string }` (defaults to caller's team) and return `{ agents: Array<{ agent_id, role, display_name?, model?, tmux_pane_id?, last_seen_at, online: boolean }> }`. `online` MUST be true when `last_seen_at` is within the last 5 minutes. Agents from other teams MUST NOT appear. The `tmux_pane_id` field MUST be present in every agent entry; its value is the persisted pane id (string) or `null` if unset.

#### Scenario: list_agents returns tmux_pane_id for each agent

- **GIVEN** agent `sess-A` has `tmux_pane_id = '%42'` and agent `sess-B` has `tmux_pane_id = NULL`
- **WHEN** `list_agents({})` is called
- **THEN** the response contains both agents
- **AND** the entry for `sess-A` has `tmux_pane_id === '%42'`
- **AND** the entry for `sess-B` has `tmux_pane_id === null`

## ADDED Requirements

### Requirement: Tmux pane id persistence

Agents MAY report a tmux pane identifier at registration time to enable cross-session interrupt delivery (e.g. future `poke` MCP tool). The field is optional and MUST NOT be required in non-tmux environments. The daemon treats the value as an opaque string — it does not parse or validate tmux pane id format, leaving the interpretation to downstream consumers.

#### Scenario: Missing tmux_pane_id persists as NULL

- **GIVEN** a `register_agent` call that omits the `tmux_pane_id` field
- **WHEN** the daemon processes the registration
- **THEN** the agents row's `tmux_pane_id` column stores NULL
- **AND** the call returns success
- **AND** `list_agents` entry for this agent has `tmux_pane_id === null`

#### Scenario: Non-tmux environment unaffected by new field

- **GIVEN** a register_agent call from an IDE plugin (no tmux) omitting `tmux_pane_id`
- **WHEN** the call is processed
- **THEN** the daemon does not error, does not warn, and persists the row with `tmux_pane_id IS NULL`

#### Scenario: Opaque string preserved regardless of format

- **GIVEN** a register_agent call with `tmux_pane_id = 'custom-pane-token-xyz'` (not a standard tmux pane id)
- **WHEN** the call is processed
- **THEN** the daemon stores the literal string `'custom-pane-token-xyz'` in the column
- **AND** `list_agents` returns the literal string unchanged
