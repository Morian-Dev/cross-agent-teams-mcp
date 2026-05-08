## MODIFIED Requirements

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
   - If no row exists for `(team, name)`: INSERT a new row with a freshly generated `agent_id = randomUUID()`, the provided `role`, `model`, `registered_at = now`, `last_seen_at = now`, `tmux_pane_id = NULL` unless an earlier runtime binding already existed for that identity, and `last_processed_event_id = COALESCE((SELECT MAX(event_id) FROM events), 0)` so the brand-new agent does not see historical mail addressed to anyone. The MAX read MUST happen inside the same transaction as the INSERT to avoid a race where a new event lands between the read and the insert.
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

#### Scenario: New identity creates a fresh agent_id with cursor at current MAX(event_id)

- **GIVEN** the agents table has no row for `(team='default', name='alice')`
- **AND** the events table currently has `MAX(event_id) = 137`
- **WHEN** a new MCP session calls `register_agent({ agent_type: 'custom', agent_type_name: 'cursor', model: 'opus-4-7', role: 'backend', name: 'alice' })`
- **THEN** response is `{ agent_id: <uuid>, team: 'default' }`
- **AND** the agents row has `name='alice'`, `role='backend'`, `team='default'`, `agent_type='custom'`, `agent_type_name='cursor'`
- **AND** the agents row has `last_processed_event_id = 137`
- **AND** `agent_id` is NOT equal to the MCP session id

#### Scenario: New identity in an empty events table starts at cursor 0

- **GIVEN** the agents table has no row for `(team='default', name='alice')`
- **AND** the events table is empty (`MAX(event_id) IS NULL`)
- **WHEN** a new MCP session calls `register_agent({ agent_type: 'custom', agent_type_name: 'cursor', name: 'alice' })`
- **THEN** the agents row's `last_processed_event_id` is `0`

#### Scenario: Reconnect reuses existing agent_id

- **GIVEN** agent with `(team='default', name='alice')` already exists with `agent_id='X'` and `role='backend'`
- **WHEN** a different MCP session (new session id) calls `register_agent({ agent_type: 'custom', agent_type_name: 'cursor', model: 'opus-4-7', role: 'backend', name: 'alice' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }` (same X as before)
- **AND** the agents table still has exactly one row for this identity
- **AND** that row's `last_seen_at` is updated to the current timestamp
- **AND** that row's `registered_at` is unchanged from the original registration
- **AND** that row's `last_processed_event_id` is unchanged (the MAX-init only fires on fresh INSERTs)

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

### Requirement: Sentinel migration advances stale zero cursors on schema apply

`applySchema` SHALL run an idempotent one-shot migration that advances every `agents` row whose `last_processed_event_id = 0` to the current `MAX(event_id)` of the events table:

```
UPDATE agents
   SET last_processed_event_id = COALESCE((SELECT MAX(event_id) FROM events), 0)
 WHERE last_processed_event_id = 0
```

The migration MUST be safe to run on every daemon boot. Once an agent's cursor has advanced past 0 (either via this migration, via a fresh registration, or via the new `get_inbox` auto-advance), this UPDATE WHERE-clause matches no rows and the migration is a no-op. There MUST be no separate migrations table or version flag — the `last_processed_event_id = 0` predicate is itself the sentinel.

The migration MUST run BEFORE the daemon accepts any MCP traffic (i.e. inside `applySchema` or the bootstrap path it is part of), so that the very first `get_inbox()` call on this boot already sees a non-zero cursor and does not re-emit the entire historical mailbox.

#### Scenario: Existing zero-cursor agent is advanced on first boot post-deploy

- **GIVEN** before the deploy, an existing agent row has `last_processed_event_id = 0`
- **AND** the events table has `MAX(event_id) = 500`
- **WHEN** the daemon boots and `applySchema` runs
- **THEN** that agent's `last_processed_event_id` is now `500`

#### Scenario: Migration is idempotent on subsequent boots

- **GIVEN** every agent row already has `last_processed_event_id > 0` after a prior boot ran the migration
- **AND** new events have appeared since then, raising `MAX(event_id)` further
- **WHEN** the daemon boots again and `applySchema` runs
- **THEN** no agent row is modified (the WHERE clause matches zero rows)
- **AND** existing cursors are NOT bumped to the new MAX (preserving each agent's own pace)

#### Scenario: Migration on empty events table sets cursors to zero (no-op)

- **GIVEN** an existing agent row with `last_processed_event_id = 0`
- **AND** the events table is empty (`MAX(event_id) IS NULL`)
- **WHEN** the daemon boots and `applySchema` runs
- **THEN** the agent's `last_processed_event_id` remains `0` (COALESCE → 0)
- **AND** no error is raised
