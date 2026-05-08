# agent-registry Specification

## Purpose

Persist agent identity tied to MCP session ids, scope visibility by team, and track liveness for all MCP tool callers.
## Requirements
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

### Requirement: last_seen_at updates on any tool invocation

Every MCP tool invocation by an authenticated agent SHALL update the caller's `agents.last_seen_at` to the current timestamp before returning.

#### Scenario: Tool call bumps last_seen_at

- **GIVEN** agent `sess-A` last_seen_at is 1 hour ago
- **WHEN** `sess-A` calls any tool (e.g. `list_agents`)
- **THEN** after the call, `agents.last_seen_at` for `sess-A` is within the last second

### Requirement: Tmux pane id persistence

The daemon MUST NOT auto-detect and persist `tmux_pane_id` during `register_agent`.  Instead, tmux pane binding is written only by explicit runtime-binding paths after registration.  `register_agent` may still succeed with `tmux_pane_id = NULL`.

#### Scenario: register_agent succeeds without auto-detecting a pane

- **GIVEN** a caller invokes `register_agent({ model, name: 'alice' })`
- **WHEN** the daemon processes the registration
- **THEN** the call succeeds
- **AND** the row may still have `tmux_pane_id = NULL`
- **AND** the success hint directs the caller to `bind_runtime_identity(...)`

### Requirement: detect_tmux_pane discovers the real agent UI pane

The daemon SHALL register an MCP tool named `detect_tmux_pane` that helps callers discover the tmux pane actually hosting a coding-agent UI, even when the shell used for tool execution lives in a different pane.  The tool SHALL accept `{ agent: 'codex' | 'claude-code' | 'opencode' | 'custom', cwd?: string, tty?: string, title_contains?: string, process_pattern?: string }`.

The detector SHALL scan tmux panes globally, map each pane to its tty, inspect the real processes attached to that tty, and rank candidates using tty/process evidence rather than trusting `$TMUX_PANE` or tmux focus state alone.  For `agent='custom'`, `process_pattern` MUST be required.  Successful responses SHALL return the single best pane plus candidate metadata; ties at the highest score SHALL return an ambiguity result instead of guessing.

#### Scenario: detect_tmux_pane finds Codex UI pane when shell pane differs

- **GIVEN** a workspace where the shell invoking MCP tools lives in tmux pane `%1863`
- **AND** the visible Codex UI is running in tmux pane `%1902`
- **AND** `%1902` owns the tty whose live processes include `codex --remote ...`
- **WHEN** the caller invokes `detect_tmux_pane({ agent: 'codex', cwd: '/workspace/project' })`
- **THEN** the tool returns `{ ok: true, pane: { pane_id: '%1902', ... } }`
- **AND** the returned candidate metadata reflects tty/process evidence for `%1902`

#### Scenario: detect_tmux_pane returns ambiguous_match on tied candidates

- **GIVEN** two tmux panes both satisfy the selected agent matcher with the same highest score
- **WHEN** the caller invokes `detect_tmux_pane(...)`
- **THEN** the tool returns `{ error: 'ambiguous_match', candidates: [...] }`
- **AND** it does not silently choose one pane

### Requirement: register_agent response hints when tmux_pane_id missing

The daemon MUST attach a `hint: string` field to the successful `register_agent` response if and only if the call still ends without a usable registered `tmux_pane_id` after any best-effort automatic runtime-binding attempt AND did NOT provide a non-tmux delivery in the same call.  "Not usable" means the field is (a) omitted, (b) an empty string, or (c) a string consisting only of whitespace.  A trimmed non-empty value suppresses the hint.  Error envelopes MUST NEVER carry a hint.

The hint text MUST advise the caller that automatic runtime binding did not converge for this session and that explicit `bind_runtime_identity(...)` remains available as the fallback write path.  The hint MAY mention `detect_tmux_pane(...)` as a debugging aid for ambiguous or missing matches.  The text SHOULD mention cross-agent poke delivery as the motivation.

#### Scenario: Register succeeds without a usable pane and returns a hint

- **GIVEN** a caller that invokes `register_agent({ agent_type: 'custom', model, role })`
- **WHEN** the call is processed and succeeds
- **THEN** the response contains `hint: <string>`
- **AND** the hint string contains the substring `tmux_pane_id`
- **AND** the hint string contains the substring `agent`

#### Scenario: Hint mentions detector debugging for split shell and UI setups

- **GIVEN** a caller that succeeds in `register_agent(...)` without registering a usable pane
- **AND** the deployment may execute shell tools in a helper pane while the visible agent UI runs in another pane
- **WHEN** the daemon returns the success envelope
- **THEN** the `hint` string contains the substring `detect_tmux_pane`
- **AND** the hint string recommends using the detector for debugging and `bind_runtime_identity(...)` for explicit fallback binding

#### Scenario: Explicit tmux_pane_id input is rejected at the schema layer

- **WHEN** a caller invokes `register_agent({ agent_type: 'custom', model, name, role, tmux_pane_id: '%42' })`
- **THEN** the call is rejected at the schema layer as an unrecognized top-level key
- **AND** no row is created or updated

#### Scenario: Non-tmux delivery suppresses hint

- **GIVEN** a caller that invokes `register_agent({ agent_type: 'codex', model, role, delivery: { kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799' } })`
- **WHEN** the call is processed and succeeds
- **THEN** the response object MUST NOT have a `hint` field

#### Scenario: Error envelope never includes hint

- **GIVEN** a register_agent call that fails (e.g. caller unregistered or `agent_id_collision` or any non-success path)
- **WHEN** the daemon returns the error envelope
- **THEN** the response object MUST NOT have a `hint` field

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

### Requirement: Repeated register_agent for same identity updates metadata

Any subsequent `register_agent` call for a `(team, name)` pair that already has a row in the agents table SHALL upsert metadata on that existing row without producing a new `agent_id`, regardless of whether the call originates from the same MCP session or a new one, and regardless of whether the `role` parameter on the subsequent call matches the persisted `role`.

Upsert fields: `role`, `model`, `last_seen_at` are overwritten by the incoming values; `tmux_pane_id` is overwritten only when the current registration attempt resolves a usable pane id; `agent_id`, `registered_at`, and `last_processed_event_id` are preserved.

#### Scenario: Same session re-registers and replaces tmux_pane_id after a new detector result

- **GIVEN** session `sess-A` has registered `(default, alice)` with `role='backend'`, `tmux_pane_id='%42'` and received `agent_id='X'`
- **AND** a later registration attempt auto-detects `%99` as the unique pane for that same identity
- **WHEN** the same session calls `register_agent({ agent_type: 'custom', model, role: 'backend', name: 'alice' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }`
- **AND** the row's `tmux_pane_id` becomes `'%99'`

#### Scenario: Re-register after reconnect preserves mailbox continuity

- **GIVEN** agent with `agent_id='X'` has unread messages addressed to X in the mailbox, and `last_processed_event_id=5`
- **WHEN** the owner reconnects (new MCP session) and calls `register_agent({ agent_type: 'custom', model, role, name })` for the same `(team, name)` identity — with the same OR a different `role`
- **THEN** the returned `agent_id` is `'X'`
- **AND** the row's `last_processed_event_id` is still `5`
- **AND** a subsequent `get_inbox()` call returns those unread messages

### Requirement: Within-session agent_id_collision via Authorization header

When a `register_agent` tool call carries an `Authorization` request header, the daemon MUST bind that session id to the sha256 hash of the (trimmed) header value on first binding, and MUST return `{ error: 'agent_id_collision' }` with HTTP status 409 on any subsequent `register_agent` for the **same MCP session id** presenting a different `Authorization` value.

When a `register_agent` call targets a `(team, name)` pair that is currently bound to a DIFFERENT MCP session id (a "cross-session re-claim"), the daemon MUST treat the new call as a TAKEOVER of that identity rather than a collision:

1. Update the in-memory connection binding for `(team, name)` to point to the new MCP session id.
2. Force-close the prior MCP transport associated with the old session id by invoking the SDK transport's `close()` method on it. The close MUST propagate through the transport's `onclose` chain so the prior session is removed from the daemon's `sessions` Map, its SSE fanout binding is detached, and its channel-wake binding (if any) is detached.
3. Proceed with the normal identity-reuse upsert path on the agents row (preserving `agent_id`, `registered_at`, `last_processed_event_id`; updating `last_seen_at`, `role`, `model`, etc.) and return `{ agent_id, team }` for the new session.
4. Log the takeover at debug level identifying the old session id, the new session id, and `(team, name)`. The log line MUST be emitted EVEN when the old session id is unknown to the transport (defensive-only path).

This collision protection is therefore now scoped to **within-session Authorization mismatch** only. Cross-session `register_agent` calls targeting the same `(team, name)` identity from a NEW MCP session id are ALWAYS legitimate takeover, regardless of whether the prior session is still alive in the `sessions` Map at the time of the takeover.

When the request carries no `Authorization` header (or an empty one after trim), the daemon MUST NOT enforce Authorization-based collision detection.

Arriving on a different TCP socket (e.g. after keep-alive expiry) MUST NOT by itself trigger a collision.

#### Scenario: Different Authorization credentials on same session id

- **GIVEN** session `sess-A` was first bound to the sha256 of `Authorization: Bearer tokenX`
- **WHEN** a request with `Mcp-Session-Id: sess-A` AND `Authorization: Bearer tokenY` calls `register_agent`
- **THEN** response is HTTP 409 with body `{ error: 'agent_id_collision' }`

#### Scenario: Cross-session same identity under different Authorization reuses agent_id

- **GIVEN** session `sess-A` has registered `(default, alice)` with `Authorization: Bearer tokenX`, then `sess-A` has been released (connection closed)
- **WHEN** session `sess-B` calls `register_agent` for `(default, alice)` with `Authorization: Bearer tokenY`
- **THEN** response is `{ agent_id: <the id from sess-A>, team: 'default' }` (reuse, not collision)

#### Scenario: Cross-session takeover while prior session is still live

- **GIVEN** session `sess-A` has called `register_agent` for `(default, alice)` and the daemon's `sessions` Map still contains `sess-A`
- **AND** `sess-A` has NOT sent DELETE and its MCP transport is still open
- **WHEN** a new MCP session `sess-B` calls `register_agent` for `(default, alice)` (no Authorization header on either call)
- **THEN** response is `{ agent_id: <the id from sess-A>, team: 'default' }` (200 OK, NOT 409)
- **AND** the daemon's in-memory connection binding for `('default', 'alice')` now points to `sess-B`
- **AND** the prior MCP transport for `sess-A` has been closed by the daemon
- **AND** `sess-A` no longer appears in the `sessions` Map

#### Scenario: Cross-session takeover emits a debug log

- **GIVEN** the conditions of the prior scenario hold
- **WHEN** the takeover is processed
- **THEN** the daemon emits a debug-level log line containing `takeover`, the old session id, the new session id, the team `'default'`, and the name `'alice'`

### Requirement: Mismatched agent_id for tool call returns 403

If a tool call explicitly carries a `from_agent_id` parameter that does not match the caller's **currently registered agent_id** (held in the session's `agentIdHolder.current`), the daemon MUST return HTTP 403 with body `{ error: 'identity_mismatch' }`.

Before the session has called `register_agent` successfully, `agentIdHolder.current` is `undefined`; any tool call other than `register_agent` MUST also be rejected (unregistered session).

#### Scenario: send_message with spoofed from_agent_id

- **GIVEN** session `sess-A` has registered and holds `agentIdHolder.current = 'X'`
- **WHEN** a tool call on this session arrives with `from_agent_id='Y'` (not `'X'`)
- **THEN** the daemon rejects with 403 `{ error: 'identity_mismatch' }`

#### Scenario: Unregistered session calling business tool is rejected

- **GIVEN** a fresh MCP session that has not yet called `register_agent`
- **WHEN** it calls `list_agents` (or any business tool)
- **THEN** the call is rejected (unregistered)

### Requirement: Agents table includes delivery_kind and delivery_payload columns

The `agents` table SHALL include two additional columns for persisting the agent's `DeliverySpec`, see `agent-delivery/spec.md`: `delivery_kind TEXT NOT NULL DEFAULT 'none'` and `delivery_payload TEXT`, nullable and storing a JSON string when non-null.  These two columns together are the authoritative storage for the delivery channel.  `delivery_kind` defaults to `'none'` so that rows inserted by code paths that do not yet supply delivery remain valid.

#### Scenario: Fresh database creates agents table with delivery_kind and delivery_payload columns

- **WHEN** the daemon bootstraps a fresh database
- **THEN** `PRAGMA table_info('agents')` lists a column named `delivery_kind` with type `TEXT`, `notnull = 1`, and default value `'none'`
- **AND** `PRAGMA table_info('agents')` lists a column named `delivery_payload` with type `TEXT` and `notnull = 0`
- **AND** rows inserted without providing delivery fields have `delivery_kind='none'` and `delivery_payload IS NULL`

### Requirement: Startup migration adds delivery columns and backfills from channel_session_id

On daemon startup, when the `agents` table is missing the `delivery_kind` or `delivery_payload` columns, the daemon SHALL execute an additive migration in a single transaction:

1. `ALTER TABLE agents ADD COLUMN delivery_kind TEXT NOT NULL DEFAULT 'none'`, if missing.
2. `ALTER TABLE agents ADD COLUMN delivery_payload TEXT`, if missing.
3. `UPDATE agents SET delivery_kind='claude-channel', delivery_payload=json_object('channel_session_id', channel_session_id) WHERE channel_session_id IS NOT NULL AND delivery_kind='none'`

The migration MUST be idempotent: if both columns already exist, no ALTER is issued.  The UPDATE SHALL only affect rows whose `channel_session_id` is non-null and `delivery_kind` is still the default `'none'`.  The migration MUST NOT modify the legacy `channel_session_id` column.

#### Scenario: Startup migration on old schema adds both columns

- **GIVEN** an existing `data.db` where `agents` table lacks `delivery_kind` and `delivery_payload` columns
- **WHEN** the daemon starts
- **THEN** both columns are added with their declared types and defaults

#### Scenario: Startup migration backfills claude-channel rows

- **GIVEN** an existing `agents` row with `channel_session_id='csid-abc'` and no `delivery_*` columns yet
- **WHEN** the daemon starts and the migration completes
- **THEN** the row has `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`

#### Scenario: Startup migration is idempotent

- **GIVEN** the daemon has already migrated the database in a previous run
- **WHEN** the daemon starts again
- **THEN** no ALTER statements are issued
- **AND** no existing `delivery_kind` or `delivery_payload` values are overwritten

#### Scenario: Startup migration leaves channel_session_id column untouched

- **GIVEN** the migration runs against an old schema
- **WHEN** the migration completes
- **THEN** every row's original `channel_session_id` value is unchanged

### Requirement: register_agent accepts optional delivery field

The `register_agent` MCP tool SHALL accept an optional `delivery: DeliverySpec` field in its input.  When omitted, the tool behaves as before and persists `delivery_kind='none'`, `delivery_payload=NULL` on insert, or leaves existing delivery untouched on an idempotent re-registration.  When provided, the tool validates it via the `agent-delivery` write validator and persists `delivery_kind` / `delivery_payload` in the same transaction that writes the identity row.

Validation failures SHALL return `{error: 'invalid_delivery', reason: ...}` without writing any row.

#### Scenario: register_agent without delivery preserves existing default behavior

- **GIVEN** a fresh MCP session calling `register_agent({agent_type: 'custom', team: 'default', name: 'alice', model: 'sonnet'})` with no `delivery` field
- **WHEN** the tool returns successfully
- **THEN** the `agents` row for alice has `delivery_kind='none'` and `delivery_payload IS NULL`

#### Scenario: register_agent with delivery kind 'claude-channel' persists both columns atomically

- **GIVEN** a caller supplies `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}` alongside identity fields
- **WHEN** the tool returns successfully
- **THEN** the `agents` row has both the identity fields and `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`

#### Scenario: register_agent with delivery kind 'codex-appserver' persists both columns atomically

- **GIVEN** a caller supplies `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799', auth_token_ref: 'CODEX_REMOTE_TOKEN'}` alongside identity fields
- **WHEN** the tool returns successfully
- **THEN** the `agents` row has `delivery_kind='codex-appserver'`
- **AND** `delivery_payload='{\"thread_id\":\"11111111-1111-4111-8111-111111111111\",\"ws_url\":\"ws://127.0.0.1:8799\",\"auth_token_ref\":\"CODEX_REMOTE_TOKEN\"}'`

#### Scenario: register_agent with invalid codex delivery rejects without inserting

- **GIVEN** a caller supplies `delivery={kind: 'codex-appserver', thread_id: 'not-a-uuid', ws_url: 'ws://127.0.0.1:8799'}` for a not-yet-registered `(team, name)`
- **WHEN** the tool validates the payload
- **THEN** it returns `{error: 'invalid_delivery', reason: 'invalid_thread_id'}`
- **AND** no row is inserted for that identity

### Requirement: register_agent registers a Codex app-server delivery without implicit tmux binding

The daemon SHALL expose Codex app-server registration through `register_agent({ agent_type: 'codex', ... })`.  For Codex callers, the tool accepts the normal identity fields plus optional `ws_url`, `auth_token_ref`, and `thread_id`.  It SHALL:

1. Connect to the Codex app-server websocket, defaulting `ws_url` to `ws://127.0.0.1:8799` when not provided.
2. Initialize the Codex protocol.
3. If `thread_id` is provided, attempt `thread/resume` only for that thread id.
4. If `thread_id` is omitted, call `thread/loaded/list`, attempt `thread/resume` against the loaded thread ids, and return `{ error: 'thread_id_required', detail: { ws_url, thread_ids: [...] } }` instead of registering any thread.
5. Register the caller as `delivery.kind='codex-appserver'` only after a caller-supplied `thread_id` has been confirmed resumable.
6. Leave tmux pane binding unchanged.  If the caller wants tmux fallback delivery, it MUST rely on the normal runtime-binding path or invoke `bind_runtime_identity(...)` explicitly afterward.

The daemon MUST NOT infer the caller's current Codex thread solely from the set of loaded or resumable threads.  The tool surface MUST reject Codex-only top-level fields unless `agent_type='codex'`.  When no new usable pane id is available, the persisted `tmux_pane_id` follows the normal registration semantics: omit on first insert yields `NULL`, omit on re-registration preserves the existing value.

The Codex registration path is Codex-only.  If the websocket endpoint is unreachable or does not speak the expected Codex protocol, the tool SHALL return `{error: 'unsupported_client', detail: { expected: 'codex', reason: ..., ws_url, cause? }}` rather than guessing.

#### Scenario: register_agent registers a caller-supplied Codex thread_id without changing tmux pane state

- **GIVEN** the caller invokes `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5', team: 'default', role: 'worker', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** `thread/resume` succeeds for `11111111-1111-4111-8111-111111111111`
- **WHEN** the tool completes successfully
- **THEN** it returns `{ agent_id, team: 'default', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799' }`
- **AND** the caller's `agents` row is persisted with `delivery.kind='codex-appserver'`
- **AND** the tool does not require tmux pane discovery to succeed

#### Scenario: register_agent rejects Codex thread inputs without agent_type=codex

- **WHEN** a caller invokes `register_agent({ agent_type: 'custom', name: 'lead', model: 'gpt-5', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **THEN** the MCP tool schema rejects the request as carrying an unknown top-level key
- **AND** the tool does not accept Codex-only fields unless `agent_type='codex'`

#### Scenario: explicit runtime binding can follow Codex register_agent

- **GIVEN** the caller first succeeds with `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** the caller still has no usable persisted `tmux_pane_id`
- **WHEN** the caller later invokes `bind_runtime_identity(...)` successfully
- **THEN** the existing `delivery.kind='codex-appserver'` remains intact
- **AND** the caller row gains the verified `tmux_pane_id` written by the runtime-binding path

#### Scenario: re-registration preserves existing pane when no new pane is found

- **GIVEN** agent `(default, lead)` already exists with `tmux_pane_id='%42'`
- **AND** the caller invokes `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5', team: 'default', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** `thread/resume` succeeds for `11111111-1111-4111-8111-111111111111`
- **AND** Codex tmux pane detection returns `not_found`
- **WHEN** the tool completes successfully
- **THEN** the caller's `agents` row keeps `tmux_pane_id='%42'`
- **AND** the caller's `agents` row is updated with the newly confirmed `delivery.kind='codex-appserver'`

#### Scenario: register_agent requires explicit thread_id when resumable threads exist for Codex

- **GIVEN** the caller invokes `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5' })`
- **AND** the default websocket endpoint reports resumable thread ids `['11111111-1111-4111-8111-111111111111']`
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'thread_id_required', detail: { ws_url: 'ws://127.0.0.1:8799', thread_ids: ['11111111-1111-4111-8111-111111111111'] } }`
- **AND** no `agents` row is inserted or updated for the caller

#### Scenario: register_agent returns no_loaded_threads for Codex

- **GIVEN** the caller invokes `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5' })`
- **AND** the Codex app-server reports zero loaded threads
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'no_loaded_threads', detail: { ws_url: 'ws://127.0.0.1:8799' } }`

#### Scenario: register_agent returns codex_resume_failed for an explicit thread_id

- **GIVEN** the caller invokes `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** the app-server returns a JSON-RPC error for `thread/resume`
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'codex_resume_failed', detail: { thread_id: '11111111-1111-4111-8111-111111111111', cause: ... } }`

#### Scenario: register_agent returns unsupported_client outside Codex

- **GIVEN** the caller invokes `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** the websocket endpoint is unreachable or does not implement the Codex protocol
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'unsupported_client', detail: { expected: 'codex', reason: ..., ws_url, cause? } }`

### Requirement: list_agents returns delivery field

`list_agents` response entries SHALL include a `delivery` field that is a public projection of the agent's internal `DeliverySpec`. The projected shape is strictly limited to the kind discriminant and, for `claude-channel`, the `channel_session_id` already exposed separately at the top level:

- For any agent, `delivery.kind` is one of the supported `DeliveryKind` values (`'none'`, `'claude-channel'`, `'codex-appserver'`).
- For `delivery.kind === 'claude-channel'`, `delivery` also includes `channel_session_id: string`.
- For all other kinds, `delivery` includes only `kind`.

Transport-specific routing fields — specifically `thread_id`, `ws_url`, and `auth_token_ref` for `codex-appserver`, and any future kind's payload — SHALL NOT appear in `list_agents` response entries. Internal callers (dispatchers, `AgentsRepo.getById`) continue to see the full `DeliverySpec`; only the MCP wire response is projected.

#### Scenario: list_agents surfaces delivery for kind 'claude-channel'

- **GIVEN** team `default` has agent `alice` with `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `alice` has `delivery: {kind: 'claude-channel', channel_session_id: 'csid-abc'}`

#### Scenario: list_agents surfaces delivery kind 'none' for agents with no channel

- **GIVEN** team `default` has agent `bob` with `delivery_kind='none'` and `delivery_payload IS NULL`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `bob` has `delivery: {kind: 'none'}`

#### Scenario: list_agents hides codex-appserver routing fields from peers

- **GIVEN** team `default` has agent `carol` with `delivery_kind='codex-appserver'` and `delivery_payload='{\"thread_id\":\"11111111-1111-4111-8111-111111111111\",\"ws_url\":\"ws://127.0.0.1:8799\",\"auth_token_ref\":\"env:TOKEN\"}'`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `carol` has `delivery.kind === 'codex-appserver'`
- **AND** the entry for `carol` has no `delivery.thread_id` field
- **AND** the entry for `carol` has no `delivery.ws_url` field
- **AND** the entry for `carol` has no `delivery.auth_token_ref` field

### Requirement: Agents table includes channel_session_id column

The `agents` table SHALL retain the existing nullable column `channel_session_id TEXT` for backward compatibility.  This column is now legacy and read-only: no code path in the daemon SHALL `INSERT` or `UPDATE` the `channel_session_id` column directly; the authoritative delivery state lives in `delivery_kind` / `delivery_payload`, see `agent-delivery/spec.md`.  The column remains in `PRAGMA table_info` output so that databases migrated from older daemons continue to round-trip through backup and restore.  Removing this column is deferred to a later change.

#### Scenario: Fresh database still creates agents table with channel_session_id column

- **WHEN** the daemon bootstraps a fresh database
- **THEN** `PRAGMA table_info('agents')` lists a column named `channel_session_id`
- **AND** the column has type `TEXT` and `notnull = 0`
- **AND** rows inserted without providing `channel_session_id` have `NULL` in that column

#### Scenario: No write path updates the legacy column directly

- **GIVEN** an arbitrary sequence of `register_agent` and `bind_channel` calls against the daemon
- **WHEN** the sequence completes
- **THEN** at no point is any SQL of the form `UPDATE agents SET channel_session_id = ...` or `INSERT INTO agents (... channel_session_id ...)` executed by daemon code

### Requirement: list_agents returns channel_session_id field

`list_agents` response entries SHALL continue to include a `channel_session_id: string | null` field for backward compatibility.  This field is now derived from `delivery` per the rule in `agent-delivery/spec.md`: it equals `delivery.channel_session_id` when `delivery.kind === 'claude-channel'`, and is `null` otherwise.  The field is no longer populated by reading the legacy column value directly.

#### Scenario: list_agents surfaces derived channel_session_id for claude-channel delivery

- **GIVEN** team `default` has agent `alice` with `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}` and agent `bob` with `delivery={kind: 'none'}`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `alice` has `channel_session_id: 'csid-abc'`
- **AND** the entry for `bob` has `channel_session_id: null`

#### Scenario: list_agents returns null channel_session_id for non-claude delivery kinds

- **GIVEN** team `default` has an agent whose `delivery.kind` is anything other than `'claude-channel'`, for example `'none'` or a future kind
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry has `channel_session_id: null`

### Requirement: unregister_self removes the caller's current agent registration

The daemon SHALL expose an MCP tool `unregister_self({})` that only operates on the caller's currently-registered agent identity.

When invoked:

1. The caller MUST already be a registered agent; otherwise return `{ error: 'unknown_agent' }`.
2. The daemon MUST look for any task in the caller's team with `status='in_progress'` and `claimed_by=<caller agent_id>`. If any exists, it MUST return `{ error: 'tasks_in_progress', task_ids: string[] }` and leave all state unchanged.
3. Otherwise the daemon MUST, in one logical operation:
   - delete the caller's row from `agents`
   - delete the caller's rows from `contract_subscriptions`
   - release any in-memory session binding and identity claim associated with the caller, so the current MCP session is no longer treated as registered
4. The daemon MUST return `{ ok: true, team: <previous team>, name: <previous name>, agent_id: <previous agent_id> }`.
5. After success, any subsequent business tool call on the same MCP session MUST be rejected as `unknown_agent` until that session registers again.

Historical mailbox events, messages, contracts, and completed tasks MAY continue to reference the removed `agent_id` as stored text.  `unregister_self` MUST NOT rewrite historical rows.

#### Scenario: Registered caller successfully unregisters itself

- **GIVEN** agent `alice` is registered in team `default`
- **AND** `alice` has no task with `status='in_progress'` claimed by her `agent_id`
- **WHEN** `alice` invokes `unregister_self({})`
- **THEN** the response is `{ ok: true, team: 'default', name: 'alice', agent_id: <alice-agent-id> }`
- **AND** the `agents` table no longer has a row with that `agent_id`

#### Scenario: Unregistered session cannot call unregister_self

- **GIVEN** a fresh MCP session that has not called `register_agent`
- **WHEN** it invokes `unregister_self({})`
- **THEN** the response is `{ error: 'unknown_agent' }`

#### Scenario: unregister_self rejects caller with in-progress tasks

- **GIVEN** agent `alice` is registered in team `default`
- **AND** task `T1` in team `default` has `status='in_progress'` and `claimed_by=<alice-agent-id>`
- **WHEN** `alice` invokes `unregister_self({})`
- **THEN** the response is `{ error: 'tasks_in_progress', task_ids: ['T1'] }`
- **AND** the `agents` table still contains `alice`

#### Scenario: Successful unregister_self clears current session identity

- **GIVEN** agent `alice` successfully invoked `unregister_self({})` on MCP session `sess-A`
- **WHEN** the same session `sess-A` next invokes `get_inbox({})`
- **THEN** the response is `{ error: 'unknown_agent' }`

#### Scenario: Same identity can register again after unregister_self

- **GIVEN** agent `alice` in team `default` successfully invoked `unregister_self({})`
- **WHEN** a later MCP session invokes `register_agent({ agent_type: 'custom', model: 'opus-4-7', name: 'alice', team: 'default' })`
- **THEN** the call succeeds
- **AND** the `agents` table contains exactly one row for `(team='default', name='alice')`

### Requirement: bind_runtime_identity verifies and persists tmux runtime identity

The daemon SHALL expose `bind_runtime_identity({ agent, ui_pid?, ui_tty?, tmux_pane_id?, process_pattern? })` for registered callers.

The tool SHALL require one of:

1. `ui_pid`
2. `ui_tty` together with `tmux_pane_id`

If `ui_pid` is supplied, the daemon SHALL:

1. Read the process tty and command from the local host.
2. Verify the command matches the declared agent kind and is not a known helper process for that agent.
3. Resolve the tty to a tmux pane.
4. Persist the verified `tmux_pane_id`, `runtime_ui_pid`, `runtime_tty`, `runtime_verification_mode`, and `runtime_bound_at`.

If `ui_tty + tmux_pane_id` are supplied, the daemon SHALL:

1. Verify the pane exists and its tty equals `ui_tty`
2. Verify that tty hosts a process matching the declared agent kind and not only helper processes for that agent
3. Persist the same runtime metadata, with `runtime_ui_pid = NULL`

#### Scenario: bind_runtime_identity succeeds via ui_pid

- **GIVEN** caller `alice` is already registered
- **AND** `ui_pid` belongs to a Codex UI process whose tty maps to pane `%1902`
- **WHEN** `alice` invokes `bind_runtime_identity({ agent: 'codex', ui_pid: 81979 })`
- **THEN** the response is `{ ok: true, tmux_pane_id: '%1902', verification_mode: 'verified_pid_tty_pane', tty: 'ttys026', ui_pid: 81979 }`
- **AND** the caller row persists `tmux_pane_id='%1902'`

#### Scenario: bind_runtime_identity rejects Codex helper process ids

- **GIVEN** caller `alice` is already registered
- **AND** `ui_pid` belongs to `codex app-server` whose tty maps to pane `%1993`
- **WHEN** `alice` invokes `bind_runtime_identity({ agent: 'codex', ui_pid: 23201 })`
- **THEN** the response is `{ error: 'agent_process_mismatch' }`
- **AND** the caller row does not persist pane `%1993`

#### Scenario: bind_runtime_identity succeeds via ui_tty plus pane id

- **GIVEN** caller `alice` is already registered
- **AND** pane `%1916` exists with tty `ttys020`
- **AND** tty `ttys020` hosts a matching Claude process
- **WHEN** `alice` invokes `bind_runtime_identity({ agent: 'claude-code', ui_tty: '/dev/ttys020', tmux_pane_id: '%1916' })`
- **THEN** the response is `{ ok: true, tmux_pane_id: '%1916', verification_mode: 'verified_tty_pane', tty: 'ttys020' }`
- **AND** the caller row persists `tmux_pane_id='%1916'`

### Requirement: register_agent accepts claude_ui_pid only for __channel_proxy__ callers

The `register_agent` MCP tool SHALL accept an optional `claude_ui_pid: integer` field.  When the field is provided:

1. The `role` field on the same call MUST equal `'__channel_proxy__'`; otherwise the tool SHALL reject at the schema layer as an invalid field combination (the same error class as existing gated fields).
2. The value MUST be a positive integer; non-integer or non-positive values are rejected at the schema layer.
3. On UPSERT, `claude_ui_pid` is written to the corresponding column on the proxy's agents row.  On re-registration (same `(team, name)` identity) the value is overwritten if the new call supplies it, and preserved otherwise.

For all `role != '__channel_proxy__'` callers, the tool SHALL reject the `claude_ui_pid` key as unrecognized.

#### Scenario: proxy registration persists claude_ui_pid

- **GIVEN** a caller invokes `register_agent({agent_type:'custom', role:'__channel_proxy__', name:'channel-proxy-27245', team:'default', model:'proxy', claude_ui_pid:25424, delivery:{kind:'claude-channel', channel_session_id:'csid-abc'}})`
- **WHEN** the tool completes successfully
- **THEN** the agents row has `claude_ui_pid=25424`
- **AND** the row's `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`

#### Scenario: non-proxy caller cannot supply claude_ui_pid

- **WHEN** a caller invokes `register_agent({agent_type:'custom', role:'worker', name:'alice', model:'sonnet', claude_ui_pid:25424})`
- **THEN** the call is rejected at the schema layer
- **AND** no row is inserted or updated

#### Scenario: claude_ui_pid must be a positive integer

- **WHEN** a caller invokes `register_agent({agent_type:'custom', role:'__channel_proxy__', name:'proxy-1', model:'proxy', claude_ui_pid:0})`
- **THEN** the call is rejected at the schema layer

#### Scenario: omitted claude_ui_pid preserves existing value

- **GIVEN** the agents table contains `(default, channel-proxy-27245)` with `claude_ui_pid=25424`
- **WHEN** a new session re-registers the same identity without supplying `claude_ui_pid`
- **THEN** the row's `claude_ui_pid` is still `25424` (preserved, not NULL-ified)

### Requirement: register_agent agent_type=claude-code auto-binds channel_session_id via ui_pid match

When `register_agent({agent_type:'claude-code', ui_pid, ...})` is invoked AND the caller does NOT supply `channel_session_id` via the `delivery` field or any top-level csid argument, the daemon SHALL, after completing the identity UPSERT and any automatic runtime binding, perform a best-effort auto-bind of `delivery.kind='claude-channel'`:

1. Persist the caller's `ui_pid` onto the identity row as `runtime_ui_pid` (this already happens during ui_pid-based automatic runtime binding; when that path is skipped — e.g. tmux detection fails or already converged without ui_pid — the value MUST still be persisted on the row so auto-bind can subsequently find it).
2. Query: find a row where `role='__channel_proxy__'` AND `claude_ui_pid = <caller ui_pid>` AND `last_seen_at > now() - 5 minutes`, ordered by `last_seen_at DESC` with `LIMIT 1`. The query MUST NOT filter by team: the channel proxy always registers into `team='default'` per the `claude-channel-transport` startup sequence, while Claude Code hosts typically register into a project-derived team, so a team filter would prevent auto-bind in the common case. A single OS process (the caller's `ui_pid`) has exactly one channel proxy, so matching on `claude_ui_pid` alone uniquely identifies the correct proxy regardless of team membership.
3. If no row matches, no action is taken — the caller's delivery is left as its existing value (typically `'none'`).
4. If a row matches, extract `channel_session_id` from `delivery_payload`. If the csid also has a live `ChannelWakeFanout` sink attached in-memory, write the caller's `delivery_kind='claude-channel'` and `delivery_payload=json_object('channel_session_id', <csid>)` and include `channel_session_id: <csid>` in the response envelope. If the sink is not live, skip the write and behave as if no row matched.

This auto-bind path runs after the caller's identity row exists, before the response is returned. It is best-effort: failures or non-matches MUST NOT fail the `register_agent` call.

If the caller explicitly supplies `channel_session_id` (via `delivery.channel_session_id` or any top-level csid argument), the existing explicit-bind path (identical to `bind_channel` semantics) MUST continue to run, and the auto-bind path MUST NOT be attempted.

Callers with other agent types (`codex`, `opencode`, `custom`) are NOT affected by auto-bind — only `agent_type='claude-code'` triggers it.

#### Scenario: register_agent with agent_type=claude-code and ui_pid auto-binds when proxy row exists

- **GIVEN** a `__channel_proxy__` row exists with `team='default'`, `claude_ui_pid=25424`, `delivery_kind='claude-channel'`, `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`, and a live `ChannelWakeFanout` sink under `'csid-abc'`
- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', project_dir:'/Users/jt/workspace/cross-agent-teams-mcp', ui_pid:25424})` (no `channel_session_id`)
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`
- **AND** the caller's `runtime_ui_pid` is `25424`

#### Scenario: register_agent with agent_type=claude-code without ui_pid does NOT auto-bind

- **GIVEN** a `__channel_proxy__` row exists for some proxy
- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', project_dir:'/Users/jt/workspace/cross-agent-teams-mcp'})` with no `ui_pid`
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='none'`

#### Scenario: register_agent with agent_type=claude-code and no matching proxy leaves delivery at none

- **GIVEN** no `__channel_proxy__` row has `claude_ui_pid=99999`
- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:99999})`
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='none'`

#### Scenario: register_agent with agent_type=claude-code skips auto-bind when proxy row's sink is dead

- **GIVEN** a `__channel_proxy__` row exists with `claude_ui_pid=25424` and `delivery.channel_session_id='csid-abc'`
- **AND** no `ChannelWakeFanout` sink is attached under `'csid-abc'` (the proxy's MCP session closed)
- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:25424})`
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='none'` (no stale csid bound)

#### Scenario: explicit channel_session_id bypasses auto-bind entirely on register_agent

- **GIVEN** a `__channel_proxy__` row exists with `claude_ui_pid=25424` and `delivery.channel_session_id='csid-abc'` (live sink)
- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:25424, channel_session_id:'csid-explicit'})` and `'csid-explicit'` has a live sink attached
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_payload='{\"channel_session_id\":\"csid-explicit\"}'` (explicit value wins, auto-bind did not run)

#### Scenario: auto-bind ignores team: proxy row in team A still matches caller in team B

- **GIVEN** a `__channel_proxy__` row exists with `team='default'`, `claude_ui_pid=25424`, `delivery.channel_session_id='csid-abc'`, and a live `ChannelWakeFanout` sink under `'csid-abc'`
- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', team:'alpha', ui_pid:25424})`
- **THEN** the caller's agents row is created in team `alpha` with `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'` (proxy team `default` does NOT block the match; `claude_ui_pid` alone uniquely identifies the caller's proxy)

#### Scenario: register_agent with agent_type=codex does NOT auto-bind

- **GIVEN** a live `__channel_proxy__` row with `claude_ui_pid=25424` and `delivery.channel_session_id='csid-abc'` (live sink)
- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:'<uuid>', ui_pid:25424})`
- **THEN** the call succeeds
- **AND** the caller's agents row has its codex-specific delivery (or `delivery_kind='none'` if no codex delivery supplied) — it MUST NOT be set to `claude-channel`

### Requirement: runtime_ui_pid persisted on register_claude_self and register_agent agent_type=claude-code

When `register_agent({agent_type:'claude-code'})` is invoked with `ui_pid`, the daemon SHALL persist that value to the caller's `agents.runtime_ui_pid` column regardless of whether automatic tmux runtime binding converged. This makes `runtime_ui_pid` available to the reactive-rebind path (`claude-channel-transport`: "Proxy registration triggers reactive rebind of matching hosts") even in deployments where tmux binding was bypassed or failed.

#### Scenario: runtime_ui_pid persisted even when tmux detection does not converge

- **GIVEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:25424})`
- **AND** tmux pane detection returns `not_found`
- **WHEN** the tool completes successfully
- **THEN** the caller's agents row has `runtime_ui_pid=25424`
- **AND** the `tmux_pane_id` column is NULL

#### Scenario: runtime_ui_pid overwritten on subsequent re-registration with new ui_pid

- **GIVEN** agent `(default, opus)` already exists with `runtime_ui_pid=111`
- **WHEN** a new MCP session invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:222})`
- **THEN** the row's `runtime_ui_pid` is now `222`

### Requirement: pre_register_codex_pane tool records pending tmux pane claim

The daemon SHALL expose an MCP tool `pre_register_codex_pane` that accepts `pane_id` (string, tmux pane identifier such as `%1972`), `xats_agent_id` (non-empty string, matches the UUID the launcher will place on the `codex --remote` command line via `-c xats.agent_id="<uuid>"`), and optional `ttl_seconds` (positive integer, default `120`, capped at `600`).  On success it SHALL persist a pending pre-registration row keyed by `pane_id` and return `{ ok: true, expires_at: <ISO8601> }`.  If `pane_id` or `xats_agent_id` is missing or empty, the tool SHALL return `{ error: "invalid_arguments", detail: <message> }` without writing any state.

#### Scenario: Launcher pre-registers a pane successfully
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"4EF01740-DBAC-4F39-BD94-64A058815856"})`
- **THEN** the daemon writes a pending pre-reg row for `%1972` with the given UUID and a `ttl_seconds=120` default expiry
- **AND** returns `{ ok: true, expires_at: <now + 120s> }`

#### Scenario: Missing pane_id is rejected
- **WHEN** the launcher calls `pre_register_codex_pane({xats_agent_id:"abc"})` without `pane_id`
- **THEN** the tool returns `{ error: "invalid_arguments", detail: <message mentioning pane_id> }`
- **AND** no state is written

#### Scenario: Empty xats_agent_id is rejected
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%10", xats_agent_id:""})`
- **THEN** the tool returns `{ error: "invalid_arguments", detail: <message mentioning xats_agent_id> }`
- **AND** no state is written

#### Scenario: ttl_seconds is capped at 600
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%10", xats_agent_id:"uuid", ttl_seconds:9999})`
- **THEN** the daemon stores the row with `expires_at = now + 600s`
- **AND** the returned `expires_at` reflects the capped value

### Requirement: pre_register_codex_pane overwrites existing entry for same pane

When a pre-reg for the same `pane_id` already exists, the new call SHALL replace the stored `xats_agent_id` and `expires_at` atomically.  The previous row SHALL NOT leak to subsequent register calls.

#### Scenario: Re-launching in the same pane overwrites
- **WHEN** pane `%1972` has a pending pre-reg with `xats_agent_id=A`
- **AND** the launcher calls `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"B"})`
- **THEN** the row for `%1972` now stores `xats_agent_id=B` and a fresh `expires_at`
- **AND** any subsequent `register_agent` match uses `B`, never `A`

### Requirement: Expired pending pre-regs are ignored and garbage-collected

A pre-reg row whose `expires_at` is in the past SHALL NOT match any `register_agent` call, even if `pane_id` and argv UUID align.  The daemon SHALL remove expired rows opportunistically (at minimum: on every `pre_register_codex_pane` write and on every codex `register_agent` consumption attempt).

#### Scenario: Expired pre-reg does not match
- **WHEN** a pre-reg for pane `%1972` with UUID `A` was created with `ttl_seconds=60`
- **AND** 120 seconds have elapsed
- **AND** a codex `register_agent` call arrives while the UI in pane `%1972` still has `xats.agent_id="A"` on its argv
- **THEN** the daemon does not auto-bind via the expired pre-reg
- **AND** registration proceeds with the normal no-pane hint fallback

#### Scenario: Expired rows are removed on next write
- **WHEN** pane `%1000` has an expired pre-reg row
- **AND** any client calls `pre_register_codex_pane({pane_id:"%2000", xats_agent_id:"x"})`
- **THEN** the expired row for `%1000` is deleted as part of the write
- **AND** only the new row for `%2000` remains

### Requirement: register_agent auto-binds codex pane via pending pre-reg

When `register_agent` is called with `agent_type="codex"`, no `ui_pid`, no `tmux_pane_id`, and no explicit `delivery`, the daemon SHALL scan active pending pre-regs and select the unique row whose `pane_id` maps (via tmux `list-panes`) to a tty hosting a `codex --remote` process whose full argv contains `xats.agent_id="<stored uuid>"` (the outer double-quotes are the ones codex writes when the launcher passes `-c xats.agent_id="\"$uuid\""`).  On a unique match the daemon SHALL:

1. Extract the matched UI process pid from the pane's process table
2. Run the existing `bind_runtime_identity(agent:"codex", ui_pid:<pid>)` path to persist `tmux_pane_id`, `ui_tty`, and `runtime_ui_pid`
3. Delete the consumed pre-reg row
4. Return the normal `register_agent` success envelope without the "no usable tmux_pane_id" hint

#### Scenario: Single matching pre-reg auto-binds pane
- **GIVEN** `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"U1"})` has been called
- **AND** tmux pane `%1972` has a `codex --remote` process whose argv contains `xats.agent_id="U1"` with pid `91131`
- **WHEN** the codex agent calls `register_agent({agent_type:"codex", name:"new-gpt", model:"gpt-5", project_dir:"/p"})`
- **THEN** the daemon binds `tmux_pane_id="%1972"` with `runtime_ui_pid=91131`
- **AND** the pre-reg row for `%1972` is deleted
- **AND** the response does not include the `No usable tmux_pane_id is bound yet` hint

#### Scenario: No matching pre-reg falls back to existing behavior
- **WHEN** `register_agent({agent_type:"codex", name:"n"})` arrives with no pending pre-regs
- **THEN** the daemon takes the existing no-`ui_pid` / no-pane code path (including the standard `detect_tmux_pane` fallback and the "no usable tmux_pane_id" hint when ambiguous)
- **AND** no new error is introduced

#### Scenario: Pre-reg present but argv UUID missing does not auto-bind
- **GIVEN** `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"U1"})` has been called
- **AND** pane `%1972` runs a `codex --remote` process whose argv does NOT contain `xats.agent_id="U1"` (for example the launcher forgot the `-c` flag)
- **WHEN** a codex `register_agent` call arrives
- **THEN** the daemon does not auto-bind via this pre-reg
- **AND** the pre-reg row remains until it expires or is overwritten
- **AND** registration falls back to the existing no-pane hint path

#### Scenario: Multiple matching pre-regs do not auto-bind
- **GIVEN** two pending pre-regs, one for `%1972` (UUID U1) and one for `%1970` (UUID U2)
- **AND** both panes run `codex --remote` processes whose argv contains the respective stored UUID
- **WHEN** a single codex `register_agent` call arrives with no `ui_pid`
- **THEN** the daemon does NOT pick one arbitrarily — auto-bind is skipped to avoid cross-session misbinding
- **AND** registration falls back to the existing no-pane hint path
- **AND** both pre-reg rows remain until expiry or explicit re-claim

### Requirement: Auto-bind failure does not corrupt register_agent result

Any failure inside the pre-reg lookup / argv matching / `bind_runtime_identity` chain (tmux unavailable, ps failure, bind error, IO error) SHALL be caught and SHALL NOT propagate as a `register_agent` error.  The daemon SHALL log the failure at debug level and fall back to the existing no-pane hint path.  The registered `agent_id` row SHALL be identical to what would have been persisted without the pre-reg feature.

#### Scenario: tmux unavailable during auto-bind
- **GIVEN** a pending pre-reg for pane `%1972`
- **AND** `tmux list-panes` fails because tmux is not running
- **WHEN** a codex `register_agent` call arrives
- **THEN** the daemon returns the standard register_agent success envelope with the no-pane hint
- **AND** the pre-reg row is not deleted (so a later retry can still succeed)
- **AND** no error is raised to the caller

#### Scenario: bind_runtime_identity internal error
- **GIVEN** a pending pre-reg and a matching UI pid
- **AND** `bind_runtime_identity` fails internally (e.g., SQLite write error)
- **WHEN** a codex `register_agent` call arrives
- **THEN** the daemon returns the standard register_agent success envelope with the no-pane hint
- **AND** the agent row is still persisted (agent_type=codex, name, etc.)
- **AND** the pre-reg row is not deleted

### Requirement: register_claude_self and register_codex_self tools removed from MCP tool surface

The daemon SHALL NOT register MCP tools named `register_claude_self` or `register_codex_self`. Both names MUST be absent from the `tools/list` response across all MCP transports (Streamable HTTP and stdio). Calls naming either tool MUST fail with the standard MCP `Method not found` (or equivalent unknown-tool) error.

The underlying `RegisterCodexSelfService` class SHALL remain in source and continue to back the `register_agent({agent_type:'codex', thread_id, ...})` route inside `executeRegister`. Only the MCP-tool wrappers are removed; backend services are unchanged.

#### Scenario: tools/list omits register_claude_self

- **WHEN** an MCP client enumerates tools via `tools/list`
- **THEN** the returned tool list does NOT contain an entry whose `name` equals `register_claude_self`

#### Scenario: tools/list omits register_codex_self

- **WHEN** an MCP client enumerates tools via `tools/list`
- **THEN** the returned tool list does NOT contain an entry whose `name` equals `register_codex_self`

#### Scenario: Calling register_claude_self returns method-not-found

- **WHEN** an MCP client calls `tools/call` with `name='register_claude_self'`
- **THEN** the response is an error envelope indicating the tool is not registered (the MCP runtime's standard unknown-tool error)
- **AND** no agents row is created or modified

#### Scenario: Calling register_codex_self returns method-not-found

- **WHEN** an MCP client calls `tools/call` with `name='register_codex_self'`
- **THEN** the response is an error envelope indicating the tool is not registered
- **AND** no agents row is created or modified

### Requirement: register_agent rejects agent_type="codex" without thread_id at schema layer

The Zod schema for `register_agent` SHALL reject any call where `agent_type='codex'` and `thread_id` is missing or an empty string. The rejection MUST happen at the schema-validation layer, BEFORE any backend service runs and BEFORE any agents row is written or read. The error message MUST mention `thread_id` and SHOULD direct launcher pre-reg callers to `pre_register_codex_pane` instead.

The previous `thread_id_required` candidate-list envelope (returned by the deleted `register_codex_self` tool when `thread_id` was omitted) is NOT preserved on the `register_agent` surface — that discovery affordance is replaced by the schema-level rejection plus the DETECTION block in the tool description.

#### Scenario: agent_type='codex' without thread_id is rejected by schema

- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5'})` with no `thread_id`
- **THEN** the response is a Zod validation error citing the missing `thread_id`
- **AND** no agents row is created
- **AND** no codex-appserver handshake is attempted

#### Scenario: agent_type='codex' with empty-string thread_id is rejected by schema

- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:''})`
- **THEN** the response is a Zod validation error citing the empty `thread_id`
- **AND** no agents row is created

#### Scenario: agent_type='codex' with valid thread_id passes schema and reaches the codex-appserver path

- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:'019dbf73-e0d8-7cb1-a944-801df112b6e2'})`
- **THEN** the call routes through `RegisterCodexSelfService.register(...)` inside `executeRegister` and writes `delivery.kind='codex-appserver'` on success
- **AND** the response includes `{agent_id, team, thread_id, ws_url}`

#### Scenario: Schema rejection error message names pre_register_codex_pane

- **WHEN** the schema rejects a `agent_type='codex'` call without `thread_id`
- **THEN** the error message string contains the literal substring `pre_register_codex_pane` (or an equivalent reference to launcher pre-reg) so the LLM can self-correct

### Requirement: register_agent({agent_type:'claude-code'}) defaults model via session client info sniff when omitted

When `register_agent` is invoked with `agent_type='claude-code'` and `model` is omitted, the daemon SHALL apply the same model-default it previously applied for `register_claude_self`: it sniffs the caller's MCP session client info (via the existing `getSessionClientInfo()` helper) and supplies the resulting Claude-specific default. The behavior of `register_agent` calls with explicit `model` is unchanged — the explicit value always wins.

#### Scenario: agent_type='claude-code' without model uses session-info-derived default

- **GIVEN** the MCP session's client info reports a Claude Code build whose default model is `'claude-opus-4-7'`
- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', ui_pid:25424})` with no `model`
- **THEN** the agents row is written with `model='claude-opus-4-7'` (or whatever `defaultClaudeSelfModel(getSessionClientInfo())` returns for that build)

#### Scenario: agent_type='claude-code' with explicit model preserves explicit value

- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'sonnet-4-6'})`
- **THEN** the agents row is written with `model='sonnet-4-6'` (the default-sniff path is NOT consulted)

### Requirement: register_agent({agent_type:'codex'}) defaults ws_url to empty string when omitted

When `register_agent` is invoked with `agent_type='codex'` and `ws_url` is omitted, the daemon SHALL set `ws_url=''` before invoking the codex-appserver path. The empty string is then resolved by `RegisterCodexSelfService` to either the env override (`CROSS_AGENT_TEAMS_CODEX_WS_URL`) or the built-in default (`ws://127.0.0.1:8799`), preserving the behavior previously specific to `register_codex_self`.

#### Scenario: agent_type='codex' without ws_url uses the built-in default

- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:'<uuid>'})` without `ws_url`
- **THEN** the daemon connects to `ws://127.0.0.1:8799`
- **AND** the returned `ws_url` reflects that default

#### Scenario: agent_type='codex' without ws_url honors environment override

- **GIVEN** the daemon process environment has `CROSS_AGENT_TEAMS_CODEX_WS_URL=ws://127.0.0.1:8899`
- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:'<uuid>'})` without `ws_url`
- **THEN** the daemon connects to the env-override URL
- **AND** the returned `ws_url` is `ws://127.0.0.1:8899`

### Requirement: register_agent tool description contains DETECTION block for agent types

The `register_agent` MCP tool description SHALL contain a clearly marked DETECTION block instructing LLM callers to determine `agent_type` by running a sequence of mechanical probes against their tool shell environment, in order, with first-match-wins semantics. Only TWO active probes SHALL be promoted; everything else falls through to a `agent_type="custom"` fallback:

1. `printenv CODEX_THREAD_ID` non-empty → `agent_type='codex'`, pass that value as `thread_id` (REQUIRED for codex per the Zod refinement); do NOT pass `ui_pid` (the launcher's `pre_register_codex_pane` flow handles tmux pane binding and supplying `ui_pid` from codex disables that path).
2. `printenv CLAUDECODE` non-empty OR `printenv CLAUDE_CODE_ENTRYPOINT` non-empty → `agent_type='claude-code'`; pass `$PPID` as `ui_pid` to enable channel auto-bind.
3. None of the above → `agent_type='custom'`, `agent_type_name=<the harness you are running under, e.g. cursor, opencode, ...>`. Detect the harness name from your runtime environment when you can — for example, `printenv CURSOR_TRACE_ID` non-empty is a cursor signal — but the DETECTION block MUST also explicitly warn against guessing agent type from system-wide signals like "binary X exists on PATH", because such probes detect what the user has installed, not what runtime the LLM is inside.

The DETECTION block's textual presence is the contract — implementers may reword the prose, but the description MUST contain:

- The two probe signals `CODEX_THREAD_ID` and `CLAUDECODE` or `CLAUDE_CODE_ENTRYPOINT`.
- The `agent_type="custom"` fallback rule with the `agent_type_name` requirement.
- A reference to `CURSOR_TRACE_ID` (or equivalent) as an example of how to derive `agent_type_name` for cursor under the custom fallback — NOT as a separate active probe.
- An anti-pattern warning against system-wide probes (the literal phrase "PATH" appearing alongside language about installed binaries vs. runtime identity is sufficient).

The description MUST NOT contain the previously promoted active probe `command -v opencode` (or any other "binary X is on PATH" probe). `agent_type='opencode'` remains a valid enum value for opencode-aware launchers but MUST NOT be promoted by any DETECTION probe.

#### Scenario: tools/list returns register_agent description containing CODEX_THREAD_ID probe

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains the literal substring `CODEX_THREAD_ID`

#### Scenario: tools/list returns register_agent description containing CLAUDECODE probe

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains the literal substring `CLAUDECODE` OR `CLAUDE_CODE_ENTRYPOINT`

#### Scenario: tools/list returns register_agent description does NOT promote opencode binary probe

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string does NOT contain the literal substring `command -v opencode`
- **AND** the description string does NOT contain any clause that suggests choosing `agent_type='opencode'` based on the presence of an `opencode` binary on PATH

#### Scenario: tools/list returns register_agent description containing custom fallback rule

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains the literal substring `agent_type="custom"` (or equivalent) AND `agent_type_name` paired with a "required when agent_type=custom" or "your harness name" clause

#### Scenario: tools/list returns register_agent description containing anti-pattern warning

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains language warning against system-wide probes (the literal substring `PATH` appears together with wording that contrasts what the user has installed with what runtime the LLM is inside)

#### Scenario: register_agent description does not name the removed self tools

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string does NOT contain the literal substring `register_claude_self`
- **AND** does NOT contain the literal substring `register_codex_self`

### Requirement: Top-level MCP server instructions describe register_agent with agent_type= detection guidance

The instructions string attached to the MCP `server.setInstructions` call SHALL describe registration in terms of `register_agent` only. It MUST mention:

- `register_agent` as the single registration entry point.
- That `agent_type="codex"` requires `thread_id` from `$CODEX_THREAD_ID`.
- That `agent_type="claude-code"` should pass `$PPID` as `ui_pid` for channel auto-bind.
- That ANY other harness (cursor, opencode, an editor extension, an unknown caller) uses `agent_type="custom"` with `agent_type_name=<harness name>`.
- An anti-pattern warning that mirrors the DETECTION block: callers MUST NOT guess from system-wide signals like "binary X is on PATH" because that reflects what the user has installed, not what runtime the LLM is inside.

The instructions string MUST NOT contain the literal substrings `register_claude_self` or `register_codex_self`.

The `xats` abbreviation guidance and the `project_dir` team-default convention from the existing instructions string are preserved (covered by `mcp-transport`'s instructions requirement).

#### Scenario: instructions contain register_agent only

- **WHEN** an MCP client fetches the server `instructions` during `initialize`
- **THEN** the `instructions` string contains the literal substring `register_agent`
- **AND** does NOT contain the literal substring `register_claude_self`
- **AND** does NOT contain the literal substring `register_codex_self`

#### Scenario: instructions mention CODEX_THREAD_ID for codex callers

- **WHEN** an MCP client fetches the server `instructions` during `initialize`
- **THEN** the `instructions` string contains the literal substring `CODEX_THREAD_ID`

#### Scenario: instructions mention agent_type=custom fallback

- **WHEN** an MCP client fetches the server `instructions` during `initialize`
- **THEN** the `instructions` string mentions `agent_type="custom"` (or equivalent quoting) AND `agent_type_name`

### Requirement: register_agent treats model as truly optional regardless of agent type

The Zod schema for `register_agent` SHALL accept a missing `model` field for any value of `agent_type`. The previous schema rejection of `model === undefined && agent_type !== 'claude-code' && agent_type !== 'codex'` (with error message `'model is required'`) is removed. When `model` is omitted, the agents row's `model` column is persisted as SQL NULL.

For `agent_type='claude-code'` and `agent_type='codex'`, the existing default-injection rules in `executeRegister` still apply when the field is omitted (`defaultClaudeSelfModel(getSessionClientInfo())` and `'gpt'` respectively); for any other agent type (`opencode`, `custom`), omitted `model` means the column is left NULL.

The `register_agent` tool description and the MCP `serverInfo.instructions` string MUST state that `model` is OPTIONAL for any agent type.

#### Scenario: register_agent with agent_type='custom' and no model succeeds and stores NULL

- **WHEN** a caller invokes `register_agent({ agent_type: 'custom', agent_type_name: 'cursor', name: 'foo', project_dir: '/tmp/x' })` with no `model`
- **THEN** the call succeeds and returns `{ agent_id, team }`
- **AND** the agents row has `model IS NULL`

#### Scenario: register_agent with agent_type='claude-code' and no model still uses session-info default

- **GIVEN** the MCP session's client info reports a Claude Code build whose default model is `'claude-opus-4-7'`
- **WHEN** a caller invokes `register_agent({ agent_type: 'claude-code', name: 'opus', ui_pid: 25424 })` with no `model`
- **THEN** the agents row has `model = 'claude-opus-4-7'` (the existing claude-code default applies; the row is NOT NULL)

#### Scenario: register_agent with agent_type='codex' and no model still defaults to 'gpt'

- **WHEN** a caller invokes `register_agent({ agent_type: 'codex', name: 'gpt', thread_id: '<uuid>' })` with no `model`
- **THEN** the agents row has `model = 'gpt'` (the existing codex default applies)

#### Scenario: register_agent description states model is OPTIONAL for any agent type

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains language indicating `model` is optional regardless of `agent_type` (the literal substring `OPTIONAL` paired with `model` is sufficient)

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

