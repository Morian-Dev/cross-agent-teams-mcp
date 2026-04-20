## MODIFIED Requirements

### Requirement: Agents table schema

The database SHALL contain an `agents` table with columns: `agent_id TEXT PRIMARY KEY`, `team TEXT NOT NULL`, `role TEXT NOT NULL`, `name TEXT NOT NULL`, `model TEXT`, `registered_at TEXT NOT NULL`, `last_seen_at TEXT NOT NULL`, `last_processed_event_id INTEGER NOT NULL DEFAULT 0`, `tmux_pane_id TEXT`.

The `name` column is the human-readable identifier used as part of the 2-tuple identity key `(team, name)` — it MUST NOT be NULL and MUST NOT be empty after trimming. The `role` column remains a non-null informational field that describes the agent's function (e.g. `backend`, `frontend`) but is NOT part of the identity key; multiple successive registrations for the same `(team, name)` MAY carry different `role` values and MUST collapse to a single row. The `tmux_pane_id` column remains nullable and stores an optional tmux pane identifier (e.g. `%42`).

A UNIQUE index `agents_identity_idx` SHALL exist on `(team, name)` to support O(log n) identity lookup AND to physically prevent multiple rows with the same `(team, name)`.

#### Scenario: Fresh database creates UNIQUE identity index on (team, name)

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA index_list('agents')` contains `agents_identity_idx`
- **AND** `PRAGMA index_info('agents_identity_idx')` lists exactly two columns in order: `team`, `name`
- **AND** `PRAGMA index_list('agents')` shows `agents_identity_idx` with `unique = 1`

#### Scenario: agents table columns match schema

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA table_info('agents')` lists columns: `agent_id`, `team`, `role`, `name`, `model`, `registered_at`, `last_seen_at`, `last_processed_event_id`, `tmux_pane_id`
- **AND** the `tmux_pane_id` column exists with type `TEXT` and `notnull = 0`
- **AND** the `name` column has `notnull = 1`
- **AND** the `role` column has `notnull = 1`

#### Scenario: Inserting two rows with same (team, name) violates UNIQUE constraint

- **GIVEN** a fresh `agents` table with one row `(team='default', name='alice', role='backend', agent_id='X')`
- **WHEN** a second INSERT is attempted with `(team='default', name='alice', role='frontend', agent_id='Y')`
- **THEN** SQLite raises `UNIQUE constraint failed: agents.team, agents.name`
- **AND** only the original row `agent_id='X'` remains in the table

### Requirement: register_agent reuses agent_id by (team, name, role) identity

The `register_agent` MCP tool SHALL take `{ model: string, name: string, role?: string = 'default', team?: string = 'default', tmux_pane_id?: string }` and:

1. Trim `name` and reject with a validation error if empty.
2. Execute an atomic UPSERT keyed on `(team, name)`:
   - If no row exists for `(team, name)`: INSERT a new row with a freshly generated `agent_id = randomUUID()`, the provided `role`, `model`, `registered_at = now`, `last_seen_at = now`, and `tmux_pane_id` (or NULL when omitted/blank).
   - If a row already exists for `(team, name)`: UPDATE that row's `role`, `model`, `last_seen_at`; preserve `agent_id`, `registered_at`, and `last_processed_event_id`; set `tmux_pane_id` to the new value when the caller provided one, else preserve the existing value.
3. Return `{ agent_id, team }` where `agent_id` is either the preserved or newly generated id.

The returned `agent_id` MUST be considered the stable identity for this `(team, name)` pair across reconnects AND across role changes. Changing the `role` parameter on a subsequent register does NOT produce a new `agent_id`; it updates the existing row's `role` column in place. The MCP session id is an orthogonal transport-level artifact and MUST NOT be conflated with `agent_id`.

When `tmux_pane_id` is provided (a non-empty, non-whitespace string), its value MUST be persisted. If omitted or blank, the column value in the reuse case MUST remain the previously-persisted value (i.e. omission means "no change"); in the create-new case it MUST be NULL.

The hint-on-missing-pane-id semantics (see Requirement "register_agent response hints when tmux_pane_id missing") apply unchanged.

#### Scenario: New identity creates a fresh agent_id

- **GIVEN** the agents table has no row for `(team='default', name='alice')`
- **WHEN** a new MCP session calls `register_agent({ model: 'opus-4-7', role: 'backend', name: 'alice' })`
- **THEN** response is `{ agent_id: <uuid>, team: 'default' }`
- **AND** the agents row has `name='alice'`, `role='backend'`, `team='default'`
- **AND** `agent_id` is NOT equal to the MCP session id

#### Scenario: Reconnect reuses existing agent_id

- **GIVEN** agent with `(team='default', name='alice')` already exists with `agent_id='X'` and `role='backend'`
- **WHEN** a different MCP session (new session id) calls `register_agent({ model: 'opus-4-7', role: 'backend', name: 'alice' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }` (same X as before)
- **AND** the agents table still has exactly one row for this identity
- **AND** that row's `last_seen_at` is updated to the current timestamp
- **AND** that row's `registered_at` is unchanged from the original registration

#### Scenario: Role change updates existing agent_id in-place

- **GIVEN** agent `(team='default', name='alice')` exists with `agent_id='X'` and `role='backend'`
- **WHEN** a subsequent session calls `register_agent({ model, role: 'frontend', name: 'alice' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }` (same X — NOT a new UUID)
- **AND** the agents table still has exactly one row for `(team='default', name='alice')`
- **AND** that row's `role` is now `'frontend'`
- **AND** that row's `last_processed_event_id` (mailbox cursor) is preserved across the role change

#### Scenario: Reuse updates tmux_pane_id when provided

- **GIVEN** agent `(default, alice)` exists with `agent_id='X'`, `role='backend'`, and `tmux_pane_id='%42'`
- **WHEN** a new session calls `register_agent({ model, role: 'backend', name: 'alice', tmux_pane_id: '%99' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }`
- **AND** the row's `tmux_pane_id` is now `'%99'`

#### Scenario: Reuse preserves tmux_pane_id when omitted

- **GIVEN** agent `(default, alice)` exists with `tmux_pane_id='%42'`
- **WHEN** a new session calls `register_agent({ model, role: 'backend', name: 'alice' })` (omitting `tmux_pane_id`)
- **THEN** the row's `tmux_pane_id` remains `'%42'` (omission = no change)

#### Scenario: Team change produces new agent_id

- **GIVEN** agent `(team='default', name='alice')` exists with `agent_id='X'`
- **WHEN** a new session calls `register_agent({ model, role: 'backend', name: 'alice', team: 'alpha' })`
- **THEN** response `agent_id` is a fresh UUID (NOT `'X'`)
- **AND** two rows exist: one in team `default`, one in team `alpha`

#### Scenario: Name is required and must be non-empty

- **WHEN** a caller invokes `register_agent({ model, role: 'backend' })` (no `name` field)
- **THEN** the call is rejected at the schema layer (MCP returns a validation error; no row is created)

#### Scenario: Name after trim must be non-empty

- **WHEN** a caller invokes `register_agent({ model, role: 'backend', name: '   ' })` (whitespace only)
- **THEN** the call is rejected with a validation error; no row is created

#### Scenario: Role defaults to "default" when omitted

- **WHEN** a caller invokes `register_agent({ model: 'opus-4-7', name: 'alice' })` (no `role` field)
- **THEN** the call succeeds and the agents row has `role='default'`

#### Scenario: Team defaults to "default" when omitted

- **WHEN** a caller invokes `register_agent({ model, name: 'alice', role: 'backend' })` (no `team` field)
- **THEN** the call succeeds and the agents row has `team='default'`

### Requirement: Repeated register_agent for same identity updates metadata

Any subsequent `register_agent` call for a `(team, name)` pair that already has a row in the agents table SHALL upsert metadata on that existing row without producing a new `agent_id`, regardless of whether the call originates from the same MCP session or a new one, and regardless of whether the `role` parameter on the subsequent call matches the persisted `role`.

Upsert fields: `role`, `model`, `last_seen_at` are overwritten by the incoming values; `tmux_pane_id` is overwritten only when the caller provides a non-blank value; `agent_id`, `registered_at`, and `last_processed_event_id` are preserved.

#### Scenario: Same session re-registers with new tmux_pane_id

- **GIVEN** session `sess-A` has registered `(default, alice)` with `role='backend'`, `tmux_pane_id='%42'` and received `agent_id='X'`
- **WHEN** the same session calls `register_agent({ model, role: 'backend', name: 'alice', tmux_pane_id: '%99' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }`
- **AND** the row's `tmux_pane_id` becomes `'%99'`

#### Scenario: Re-register after reconnect preserves mailbox continuity

- **GIVEN** agent with `agent_id='X'` has unread messages addressed to X in the mailbox, and `last_processed_event_id=5`
- **WHEN** the owner reconnects (new MCP session) and calls `register_agent({ model, role, name })` for the same `(team, name)` identity — with the same OR a different `role`
- **THEN** the returned `agent_id` is `'X'`
- **AND** the row's `last_processed_event_id` is still `5`
- **AND** a subsequent `get_inbox()` call returns those unread messages

### Requirement: Within-session agent_id_collision via Authorization header

When a `register_agent` tool call carries an `Authorization` request header, the daemon MUST bind that session id to the sha256 hash of the (trimmed) header value on first binding, and MUST return `{ error: 'agent_id_collision' }` with HTTP status 409 on any subsequent `register_agent` for the **same MCP session id** presenting a different `Authorization` value.

Additionally, the daemon MUST return `{ error: 'agent_id_collision' }` with HTTP status 409 when a register_agent call targets a `(team, name)` pair that is currently bound to a different MCP session id — regardless of the `role` parameter on either the original or the incoming call.

This collision protection is scoped to within-session Authorization mismatch OR cross-session claim on an already-bound identity: cross-session `register_agent` calls targeting the same `(team, name)` identity are legitimate reuse (see the identity-reuse requirement) when the previous session has released the binding. When the request carries no `Authorization` header (or an empty one after trim), the daemon MUST NOT enforce Authorization-based collision detection.

Arriving on a different TCP socket (e.g. after keep-alive expiry) MUST NOT by itself trigger a collision.

#### Scenario: Different Authorization credentials on same session id

- **GIVEN** session `sess-A` was first bound to the sha256 of `Authorization: Bearer tokenX`
- **WHEN** a request with `Mcp-Session-Id: sess-A` AND `Authorization: Bearer tokenY` calls `register_agent`
- **THEN** response is HTTP 409 with body `{ error: 'agent_id_collision' }`

#### Scenario: Cross-session same identity under different Authorization reuses agent_id

- **GIVEN** session `sess-A` has registered `(default, alice)` with `Authorization: Bearer tokenX`, then `sess-A` has been released (connection closed)
- **WHEN** session `sess-B` calls `register_agent` for `(default, alice)` with `Authorization: Bearer tokenY`
- **THEN** response is `{ agent_id: <the id from sess-A>, team: 'default' }` (reuse, not collision)

#### Scenario: Same (team, name) claimed by a different role from another live session is a collision

- **GIVEN** session `sess-A` has registered `(team='default', name='alice', role='backend')` and is still live (connection open, binding held)
- **WHEN** session `sess-B` calls `register_agent({ model, team: 'default', name: 'alice', role: 'frontend' })`
- **THEN** response is HTTP 409 with body `{ error: 'agent_id_collision' }`
- **AND** the original row for `(default, alice)` is unchanged (still `role='backend'`, bound to `sess-A`)
