## MODIFIED Requirements

### Requirement: Agents table schema

The database SHALL contain an `agents` table with columns: `agent_id TEXT PRIMARY KEY`, `agent_type TEXT`, `agent_type_name TEXT`, `team TEXT NOT NULL`, `role TEXT NOT NULL`, `name TEXT NOT NULL`, `model TEXT`, `registered_at TEXT NOT NULL`, `last_seen_at TEXT NOT NULL`, `last_processed_event_id INTEGER NOT NULL DEFAULT 0`, `tmux_pane_id TEXT`, `claude_ui_pid INTEGER`.

The `name` column is the human-readable identifier used as part of the 2-tuple identity key `(team, name)` — it MUST NOT be NULL and MUST NOT be empty after trimming. The `role` column remains a non-null informational field that describes the agent's function (e.g. `backend`, `frontend`) but is NOT part of the identity key; multiple successive registrations for the same `(team, name)` MAY carry different `role` values and MUST collapse to a single row. The `agent_type` column stores the explicitly declared runtime kind (`codex`, `claude-code`, `opencode`, or `custom`) and MAY be NULL only for legacy rows written before this requirement. The `agent_type_name` column is nullable and stores an optional free-form runtime label used only when `agent_type='custom'`. The `tmux_pane_id` column remains nullable and stores an optional tmux pane identifier (e.g. `%42`).

The `claude_ui_pid` column is nullable and is populated only on `__channel_proxy__` rows; it stores the parent process id (`process.ppid`) of the channel proxy, which equals the Claude Code UI process id that spawned the proxy. It enables the host-to-proxy match during `register_agent({agent_type:'claude-code'})` auto-bind. For non-proxy rows it MUST remain NULL.

A UNIQUE index `agents_identity_idx` SHALL exist on `(team, name)` to support O(log n) identity lookup AND to physically prevent multiple rows with the same `(team, name)`.

On daemon startup, when the `agents` table is missing the `claude_ui_pid` column, the daemon SHALL execute an additive migration `ALTER TABLE agents ADD COLUMN claude_ui_pid INTEGER` in a single transaction; the migration is idempotent (if the column already exists, no ALTER is issued) and MUST NOT backfill values (existing rows get NULL until their next `register_agent` upsert). The column-rename migration covering `client → agent_type` and `client_name → agent_type_name` is described in a separate requirement.

#### Scenario: Fresh database creates UNIQUE identity index on (team, name)

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA index_list('agents')` contains `agents_identity_idx`
- **AND** `PRAGMA index_info('agents_identity_idx')` lists exactly two columns in order: `team`, `name`
- **AND** `PRAGMA index_list('agents')` shows `agents_identity_idx` with `unique = 1`

#### Scenario: agents table columns match schema

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA table_info('agents')` lists columns: `agent_id`, `agent_type`, `agent_type_name`, `team`, `role`, `name`, `model`, `registered_at`, `last_seen_at`, `last_processed_event_id`, `tmux_pane_id`, `claude_ui_pid`
- **AND** the `tmux_pane_id` column exists with type `TEXT` and `notnull = 0`
- **AND** the `claude_ui_pid` column exists with type `INTEGER` and `notnull = 0`
- **AND** the `name` column has `notnull = 1`
- **AND** the `role` column has `notnull = 1`
- **AND** neither `client` nor `client_name` appears in the column list

#### Scenario: Inserting two rows with same (team, name) violates UNIQUE constraint

- **GIVEN** a fresh `agents` table with one row `(team='default', name='alice', role='backend', agent_id='X')`
- **WHEN** a second INSERT is attempted with `(team='default', name='alice', role='frontend', agent_id='Y')`
- **THEN** SQLite raises `UNIQUE constraint failed: agents.team, agents.name`
- **AND** only the original row `agent_id='X'` remains in the table

#### Scenario: Startup migration adds claude_ui_pid to legacy schema

- **GIVEN** an existing `data.db` where `agents` table lacks the `claude_ui_pid` column
- **WHEN** the daemon starts
- **THEN** the migration issues `ALTER TABLE agents ADD COLUMN claude_ui_pid INTEGER`
- **AND** existing rows have `claude_ui_pid IS NULL`
- **AND** no other column values are modified

#### Scenario: Startup migration is idempotent for claude_ui_pid

- **GIVEN** the daemon has already migrated the database in a previous run so `claude_ui_pid` exists
- **WHEN** the daemon starts again
- **THEN** no ALTER statement is issued for `claude_ui_pid`

### Requirement: list_agents scoped to caller team

The `list_agents` MCP tool SHALL take `{ team?: string }` (defaults to caller's team) and return `{ agents: Array<{ agent_id, agent_type?, agent_type_name?, role, name, model?, tmux_pane_id?, last_seen_at, online: boolean }> }`. `online` MUST be true when `last_seen_at` is within the last 5 minutes. Agents from other teams MUST NOT appear. The `name` field is always present and non-empty. The `tmux_pane_id` field MUST be present in every agent entry; its value is the persisted pane id (string) or `null` if unset. `agent_type_name` SHALL be `null` unless `agent_type='custom'`. The response object MUST NOT contain legacy `client` or `client_name` keys.

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

### Requirement: register_agent reuses agent_id by (team, name, role) identity

The `register_agent` MCP tool SHALL take `{ agent_type: 'codex' | 'claude-code' | 'opencode' | 'custom', agent_type_name?: string, model?: string, name: string, role?: string = 'default', team?: string, project_dir?: string, ui_pid?: number, delivery?: DeliverySpec }` and:

1. Trim `name` and reject with a validation error if empty.
2. Require `agent_type` explicitly. `agent_type_name` MAY be supplied only when `agent_type='custom'`. The legacy field names `client` and `client_name` are NOT accepted by the strict schema and MUST produce an unknown-key validation error.
3. Derive the effective `team` value by applying this three-level precedence:
   - If `team` is provided and non-empty after trimming, use it as-is.
   - Else if `project_dir` is provided, compute `basename(project_dir)`, trim it, lowercase it (POSIX `basename` semantics — trailing slashes stripped before taking the last component), and if the result is non-empty use it as the effective team.
   - Else fall back to the literal string `'default'`.
   The derived value is then used wherever the original `team` parameter was consumed (UPSERT key, response, runtime binding).
4. Execute an atomic UPSERT keyed on `(team, name)` where `team` is the derived value:
   - If no row exists for `(team, name)`: INSERT a new row with a freshly generated `agent_id = randomUUID()`, the provided `role`, `model`, `registered_at = now`, `last_seen_at = now`, and `tmux_pane_id = NULL` unless an earlier runtime binding already existed for that identity.
   - If a row already exists for `(team, name)`: UPDATE that row's `agent_type`, `agent_type_name`, `role`, `model`, `last_seen_at`; preserve `agent_id`, `registered_at`, and `last_processed_event_id`; preserve the existing `tmux_pane_id` until a later automatic or explicit runtime-binding attempt writes a new usable value.
5. After the identity row exists, best-effort attempt automatic runtime binding for this session:
   - The daemon MUST NOT accept caller-supplied pane ids or pane-detect hints through the MCP tool surface.
   - If `ui_pid` is provided, the daemon MUST prefer the verified `ui_pid -> tty -> pane` runtime-binding path.
   - For `agent_type='codex' | 'claude-code' | 'opencode'`, the daemon MUST use that explicit kind as the built-in matcher for automatic tmux detection.
   - For `agent_type='custom'`, the daemon MUST skip built-in matcher inference and treat automatic runtime binding as not attempted unless a later dedicated binding tool is invoked.
   - If `ui_pid` is absent and a built-in matcher is available, the daemon MUST invoke the same pane detector behind `detect_tmux_pane` for that matcher, and if detection succeeds, it MUST run the same verified persistence path as `bind_runtime_identity(...)` using the detected pane's tty plus pane id.
   - If no matcher is available, or the detector/runtime binder returns `ambiguous_match`, `not_found`, `tmux_unavailable`, or any other non-success result, the daemon MUST treat this attempt as having no new pane id rather than failing the registration.
6. Return `{ agent_id, team }` where `agent_id` is either the preserved or newly generated id and `team` is the derived value from step 3.

The returned `agent_id` MUST be considered the stable identity for this `(team, name)` pair across reconnects AND across role changes. Changing the `role` parameter on a subsequent register does NOT produce a new `agent_id`; it updates the existing row's `role` column in place. The MCP session id is an orthogonal transport-level artifact and MUST NOT be conflated with `agent_id`.

When an automatic or explicit runtime-binding attempt resolves a usable `tmux_pane_id`, its value MUST be persisted. If the current registration attempt resolves no new pane id, the column value in the reuse case MUST remain the previously-persisted value; in the create-new case it MUST be NULL.

The hint-on-missing-pane-id semantics (see Requirement "register_agent response hints when tmux_pane_id missing") apply unchanged.

`project_dir` MUST be treated as an input-only hint for default team derivation; it MUST NOT be persisted on the agents row and MUST NOT be returned in the response.

#### Scenario: Automatic runtime binding persists a detected pane during register_agent

- **GIVEN** the caller invokes `register_agent({ agent_type: 'codex', model, name: 'alice', thread_id: '<uuid>' })`
- **AND** the detector converges on a single pane `%1902`
- **AND** verified runtime binding succeeds for `%1902`
- **WHEN** the call is processed and succeeds
- **THEN** the stored `tmux_pane_id` is `'%1902'`
- **AND** the response object MUST NOT have a `hint` field

#### Scenario: ui_pid drives automatic runtime binding during register_agent

- **GIVEN** the caller invokes `register_agent({ agent_type: 'claude-code', model, name: 'alice', ui_pid: 25079 })`
- **AND** verified runtime binding via `ui_pid=25079` succeeds and resolves pane `%1902`
- **WHEN** the call is processed and succeeds
- **THEN** the stored `tmux_pane_id` is `'%1902'`
- **AND** the stored `runtime_ui_pid` is `25079`
- **AND** the response object MUST NOT have a `hint` field

#### Scenario: New identity creates a fresh agent_id

- **GIVEN** the agents table has no row for `(team='default', name='alice')`
- **WHEN** a new MCP session calls `register_agent({ agent_type: 'custom', agent_type_name: 'cursor', model: 'opus-4-7', role: 'backend', name: 'alice' })`
- **THEN** response is `{ agent_id: <uuid>, team: 'default' }`
- **AND** the agents row has `name='alice'`, `role='backend'`, `team='default'`, `agent_type='custom'`, `agent_type_name='cursor'`
- **AND** `agent_id` is NOT equal to the MCP session id

#### Scenario: Reconnect reuses existing agent_id

- **GIVEN** agent with `(team='default', name='alice')` already exists with `agent_id='X'` and `role='backend'`
- **WHEN** a different MCP session (new session id) calls `register_agent({ agent_type: 'custom', agent_type_name: 'cursor', model: 'opus-4-7', role: 'backend', name: 'alice' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }` (same X as before)
- **AND** the agents table still has exactly one row for this identity
- **AND** that row's `last_seen_at` is updated to the current timestamp
- **AND** that row's `registered_at` is unchanged from the original registration

#### Scenario: Role change updates existing agent_id in-place

- **GIVEN** agent `(team='default', name='alice')` exists with `agent_id='X'` and `role='backend'`
- **WHEN** a subsequent session calls `register_agent({ agent_type: 'custom', agent_type_name: 'cursor', model, role: 'frontend', name: 'alice' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }` (same X — NOT a new UUID)
- **AND** the agents table still has exactly one row for `(team='default', name='alice')`
- **AND** that row's `role` is now `'frontend'`
- **AND** that row's `last_processed_event_id` (mailbox cursor) is preserved across the role change

#### Scenario: custom agent_type may persist agent_type_name

- **GIVEN** a caller invokes `register_agent({ agent_type: 'custom', agent_type_name: 'kimi-coder', model, name: 'alice' })`
- **WHEN** the call is processed and succeeds
- **THEN** the agents row stores `agent_type='custom'`
- **AND** the agents row stores `agent_type_name='kimi-coder'`

#### Scenario: agent_type_name is rejected for non-custom agent types

- **WHEN** a caller invokes `register_agent({ agent_type: 'codex', agent_type_name: 'codex-cli', model, name: 'alice', thread_id: '<uuid>' })`
- **THEN** the call is rejected at the schema layer

#### Scenario: missing agent_type is rejected

- **WHEN** a caller invokes `register_agent({ model, name: 'alice' })`
- **THEN** the call is rejected at the schema layer

#### Scenario: legacy client field is rejected

- **WHEN** a caller invokes `register_agent({ client: 'custom', name: 'alice' })`
- **THEN** the call is rejected at the schema layer with an unknown-key error citing `client`
- **AND** the error message hints that the field was renamed to `agent_type`

#### Scenario: legacy client_name field is rejected

- **WHEN** a caller invokes `register_agent({ agent_type: 'custom', client_name: 'cursor', name: 'alice' })`
- **THEN** the call is rejected at the schema layer with an unknown-key error citing `client_name`
- **AND** the error message hints that the field was renamed to `agent_type_name`

#### Scenario: Reuse updates tmux_pane_id when a later registration finds a new unique pane

- **GIVEN** agent `(default, alice)` exists with `agent_id='X'`, `role='backend'`, and `tmux_pane_id='%42'`
- **AND** a later registration attempt auto-detects `%99` as the unique pane for the same identity
- **WHEN** a new session calls `register_agent({ agent_type: 'custom', agent_type_name: 'cursor', model, role: 'backend', name: 'alice' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }`
- **AND** the agents row's `tmux_pane_id` is now `'%99'`

## ADDED Requirements

### Requirement: Startup migration renames client and client_name columns

On daemon startup, when the `agents` table contains a column named `client` (the pre-rename name) and does NOT yet contain a column named `agent_type`, the daemon SHALL execute these idempotent column-rename migrations in a single transaction:

```sql
ALTER TABLE agents RENAME COLUMN client      TO agent_type;
ALTER TABLE agents RENAME COLUMN client_name TO agent_type_name;
```

Detection MUST use `PRAGMA table_info(agents)` to inspect the current column list. If both `agent_type` and `agent_type_name` already exist (i.e. the migration has already run, or the database is fresh), no ALTER statements are issued. The migration MUST NOT backfill or modify any data — only the column metadata is renamed.

The `claude_ui_pid` migration (additive `ADD COLUMN`) and the `agent_type` rename migration are independent: their order MUST be defined and stable so that a database migrating from a pre-`claude_ui_pid` schema in the same boot cycle ends in a fully migrated state regardless of which migration runs first.

#### Scenario: Startup migration renames client → agent_type on legacy schema

- **GIVEN** an existing `data.db` whose `agents` table has columns including `client TEXT` and `client_name TEXT` (and no `agent_type` / `agent_type_name`)
- **WHEN** the daemon starts
- **THEN** the migration issues `ALTER TABLE agents RENAME COLUMN client TO agent_type`
- **AND** the migration issues `ALTER TABLE agents RENAME COLUMN client_name TO agent_type_name`
- **AND** all existing row data on those two columns is preserved (e.g. a row that had `client='claude-code'` now has `agent_type='claude-code'`)
- **AND** the `client` and `client_name` columns no longer exist in `PRAGMA table_info(agents)`

#### Scenario: Startup migration is idempotent on already-renamed schema

- **GIVEN** the daemon has already migrated the database in a previous run so `agent_type` and `agent_type_name` exist (and `client` / `client_name` do not)
- **WHEN** the daemon starts again
- **THEN** no `ALTER TABLE ... RENAME COLUMN` statement is issued for either column
- **AND** `PRAGMA table_info(agents)` is unchanged

#### Scenario: Fresh database starts with renamed columns and no migration runs

- **GIVEN** the daemon bootstraps a fresh `data.db`
- **THEN** the `agents` table is created directly with `agent_type` and `agent_type_name` columns (the schema CREATE statement uses the new names)
- **AND** no `ALTER TABLE ... RENAME COLUMN` statement is issued during startup
- **AND** the `client` and `client_name` columns never exist in this database
