# agent-registry Specification

## Purpose

Persist agent identity tied to MCP session ids, scope visibility by team, and track liveness for all MCP tool callers.
## Requirements
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

### Requirement: list_agents scoped to caller team

The `list_agents` MCP tool SHALL take `{ team?: string }` (defaults to caller's team) and return `{ agents: Array<{ agent_id, role, name, model?, tmux_pane_id?, last_seen_at, online: boolean }> }`. `online` MUST be true when `last_seen_at` is within the last 5 minutes. Agents from other teams MUST NOT appear. The `name` field is always present and non-empty. The `tmux_pane_id` field MUST be present in every agent entry; its value is the persisted pane id (string) or `null` if unset.

#### Scenario: Caller in team 'alpha' sees only team 'alpha' agents

- **GIVEN** two agents in team 'alpha' and three agents in team 'beta'
- **WHEN** a caller registered in team 'alpha' calls `list_agents({})`
- **THEN** the response contains exactly two agents, both with `team='alpha'`
- **AND** each agent entry has a non-empty `name` string

#### Scenario: Online flag reflects last_seen_at freshness

- **GIVEN** agent `alice` last_seen_at is 2 minutes ago, `bob` is 10 minutes ago
- **WHEN** list_agents is called
- **THEN** `alice.online === true` and `bob.online === false`

### Requirement: last_seen_at updates on any tool invocation

Every MCP tool invocation by an authenticated agent SHALL update the caller's `agents.last_seen_at` to the current timestamp before returning.

#### Scenario: Tool call bumps last_seen_at

- **GIVEN** agent `sess-A` last_seen_at is 1 hour ago
- **WHEN** `sess-A` calls any tool (e.g. `list_agents`)
- **THEN** after the call, `agents.last_seen_at` for `sess-A` is within the last second

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

The daemon MUST attach a `hint: string` field to the successful `register_agent` response if and only if the caller did NOT provide a usable `tmux_pane_id` AND did NOT provide a non-tmux delivery in the same call.  "Not usable" means the field is (a) omitted, (b) an empty string, or (c) a string consisting only of whitespace.  A trimmed non-empty value suppresses the hint.  Error envelopes MUST NEVER carry a hint.

The hint text MUST advise the caller how to discover a usable pane id before re-registering.  When the shell pane and visible agent UI are expected to be the same, the hint MUST mention `echo "$TMUX_PANE"` as the primary shell command and MAY mention `tmux display-message -p '#{pane_id}'` only as a fallback.  When the shell pane and visible agent UI may differ, the hint SHOULD mention `detect_tmux_pane({ agent, cwd })` as the safer path.  The text SHOULD mention cross-agent poke delivery as the motivation.

#### Scenario: Omitted tmux_pane_id triggers hint

- **GIVEN** a caller that invokes `register_agent({ model, role })` with no `tmux_pane_id` key at all
- **WHEN** the call is processed and succeeds
- **THEN** the response contains `hint: <string>`
- **AND** the hint string contains the substring `tmux_pane_id`
- **AND** the hint string contains the substring `TMUX_PANE`

#### Scenario: Hint mentions detect_tmux_pane for split shell and UI setups

- **GIVEN** a caller that succeeds in `register_agent(...)` without `tmux_pane_id`
- **AND** the deployment may execute shell tools in a helper pane while the visible agent UI runs in another pane
- **WHEN** the daemon returns the success envelope
- **THEN** the `hint` string contains the substring `detect_tmux_pane`
- **AND** the hint string recommends re-registering with the detected `pane_id`

#### Scenario: Empty string tmux_pane_id triggers hint

- **GIVEN** a caller that invokes `register_agent({ model, role, tmux_pane_id: '' })`
- **WHEN** the call is processed and succeeds
- **THEN** the response contains `hint: <string>` with the same form as the omitted case

#### Scenario: Whitespace-only tmux_pane_id triggers hint

- **GIVEN** a caller that invokes `register_agent({ model, role, tmux_pane_id: '   ' })`
- **WHEN** the call is processed and succeeds
- **THEN** the response contains `hint: <string>` with the same form as the omitted case

#### Scenario: Non-tmux delivery suppresses hint

- **GIVEN** a caller that invokes `register_agent({ model, role, delivery: { kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799' } })`
- **WHEN** the call is processed and succeeds
- **THEN** the response object MUST NOT have a `hint` field

#### Scenario: Error envelope never includes hint

- **GIVEN** a register_agent call that fails (e.g. caller unregistered or `agent_id_collision` or any non-success path)
- **WHEN** the daemon returns the error envelope
- **THEN** the response object MUST NOT have a `hint` field

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

- **GIVEN** a fresh MCP session calling `register_agent({team: 'default', name: 'alice', model: 'sonnet'})` with no `delivery` field
- **WHEN** the tool returns successfully
- **THEN** the `agents` row for alice has `delivery_kind='none'` and `delivery_payload IS NULL`

#### Scenario: register_agent with delivery kind 'claude-channel' persists both columns atomically

- **GIVEN** a caller supplies `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}` alongside identity fields
- **WHEN** the tool returns successfully
- **THEN** the `agents` row has both the identity fields and `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`

#### Scenario: register_agent with delivery kind 'codex-appserver' persists both columns atomically

- **GIVEN** a caller supplies `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799', auth_token_ref: 'CODEX_REMOTE_TOKEN'}` alongside identity fields
- **WHEN** the tool returns successfully
- **THEN** the `agents` row has both the identity fields and `delivery_kind='codex-appserver'`
- **AND** `delivery_payload` contains `thread_id`, `ws_url`, and `auth_token_ref`

#### Scenario: register_agent with invalid delivery rejects without inserting

- **GIVEN** a caller supplies `delivery={kind: 'claude-channel'}` for a not-yet-registered `(team, name)`
- **WHEN** the tool is invoked
- **THEN** the tool returns `{error: 'invalid_delivery', reason: 'missing_channel_session_id'}`
- **AND** no `agents` row is created for that `(team, name)`

### Requirement: register_codex_self autodetects and registers a Codex app-server delivery

The daemon SHALL expose a tool `register_codex_self` for Codex remote sessions.  The tool accepts human-facing identity fields such as `name`, `team`, and `role`, plus optional `ws_url`, `auth_token_ref`, `tmux_pane_id`, `cwd`, `tty`, and `title_contains`.  It SHALL:

1. Connect to the Codex app-server websocket, defaulting `ws_url` to `ws://127.0.0.1:8799` when not provided.
2. Initialize the Codex protocol.
3. Call `thread/loaded/list`.
4. Attempt `thread/resume` against the loaded thread ids.
5. If exactly one thread is resumable, register the caller as `delivery.kind='codex-appserver'` using that `thread_id`.
6. Persist a `tmux_pane_id` alongside the Codex delivery when either:
   - the caller supplied a usable `tmux_pane_id`, or
   - the caller omitted `tmux_pane_id` and the tool can derive a single Codex tmux pane via the existing Codex pane-detection logic, optionally narrowed by `cwd`, `tty`, or `title_contains`.
7. Treat tmux pane capture as best-effort.  If pane detection returns `not_found`, `ambiguous_match`, or `tmux_unavailable`, the tool MUST still succeed with the Codex delivery registration and MUST NOT fail the overall call solely because tmux pane discovery was incomplete.

When a usable `tmux_pane_id` is supplied directly, the tool MUST prefer that explicit value and MUST NOT replace it with detector output.  When no new usable pane id is available, the persisted `tmux_pane_id` follows the normal registration semantics: omit on first insert yields `NULL`, omit on re-registration preserves the existing value.

The tool is Codex-only.  If the websocket endpoint is unreachable or does not speak the expected Codex protocol, the tool SHALL return `{error: 'unsupported_client', detail: { expected: 'codex', reason: ..., ws_url, cause? }}` rather than guessing.

#### Scenario: register_codex_self registers the single resumable thread and detected pane

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead', team: 'default', role: 'worker', cwd: '/workspace/project' })`
- **AND** the default websocket endpoint has exactly one resumable loaded thread
- **AND** Codex tmux pane detection returns a single pane `%1902`
- **WHEN** the tool completes successfully
- **THEN** it returns `{ agent_id, team: 'default', thread_id, ws_url: 'ws://127.0.0.1:8799' }`
- **AND** the caller's `agents` row is persisted with `delivery.kind='codex-appserver'`
- **AND** the caller's `agents` row is persisted with `tmux_pane_id='%1902'`

#### Scenario: explicit tmux_pane_id overrides pane detection

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead', tmux_pane_id: '%42', cwd: '/workspace/project' })`
- **AND** the default websocket endpoint has exactly one resumable loaded thread
- **WHEN** the tool completes successfully
- **THEN** the caller's `agents` row is persisted with `tmux_pane_id='%42'`
- **AND** the tool does not require detector output to accept the pane value

#### Scenario: ambiguous pane detection does not block codex registration

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead', cwd: '/workspace/project' })`
- **AND** the default websocket endpoint has exactly one resumable loaded thread
- **AND** Codex tmux pane detection returns `ambiguous_match`
- **WHEN** the tool completes successfully
- **THEN** it still returns `{ agent_id, team, thread_id, ws_url }`
- **AND** the caller's `agents` row is persisted with `delivery.kind='codex-appserver'`
- **AND** the call does not fail with a tmux-related error

#### Scenario: re-registration preserves existing pane when no new pane is found

- **GIVEN** agent `(default, lead)` already exists with `tmux_pane_id='%42'`
- **AND** the caller invokes `register_codex_self({ name: 'lead', team: 'default' })`
- **AND** the default websocket endpoint has exactly one resumable loaded thread
- **AND** Codex tmux pane detection returns `not_found`
- **WHEN** the tool completes successfully
- **THEN** the caller's `agents` row keeps `tmux_pane_id='%42'`
- **AND** the caller's `agents` row is updated with the newly confirmed `delivery.kind='codex-appserver'`

#### Scenario: register_codex_self returns no_loaded_threads

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead' })`
- **AND** the Codex app-server reports zero loaded threads
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'no_loaded_threads', detail: { ws_url: 'ws://127.0.0.1:8799' } }`

#### Scenario: register_codex_self returns ambiguous_loaded_threads

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead' })`
- **AND** more than one loaded thread is resumable
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'ambiguous_loaded_threads', detail: { thread_ids: [...] } }`

#### Scenario: register_codex_self returns unsupported_client outside Codex

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead' })`
- **AND** the websocket endpoint is unreachable or does not implement the Codex protocol
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'unsupported_client', detail: { expected: 'codex', reason: ..., ws_url, cause? } }`

### Requirement: list_agents returns delivery field

`list_agents` response entries SHALL include a `delivery: DeliverySpec` field reflecting the agent's reconstructed `DeliverySpec`, per the reconstruction rules in `agent-delivery/spec.md`.

#### Scenario: list_agents surfaces delivery for kind 'claude-channel'

- **GIVEN** team `default` has agent `alice` with `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `alice` has `delivery: {kind: 'claude-channel', channel_session_id: 'csid-abc'}`

#### Scenario: list_agents surfaces delivery kind 'none' for agents with no channel

- **GIVEN** team `default` has agent `bob` with `delivery_kind='none'` and `delivery_payload IS NULL`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `bob` has `delivery: {kind: 'none'}`

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

