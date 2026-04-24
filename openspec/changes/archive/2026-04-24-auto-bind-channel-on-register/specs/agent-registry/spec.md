## MODIFIED Requirements

### Requirement: Agents table schema

The database SHALL contain an `agents` table with columns: `agent_id TEXT PRIMARY KEY`, `client TEXT`, `client_name TEXT`, `team TEXT NOT NULL`, `role TEXT NOT NULL`, `name TEXT NOT NULL`, `model TEXT`, `registered_at TEXT NOT NULL`, `last_seen_at TEXT NOT NULL`, `last_processed_event_id INTEGER NOT NULL DEFAULT 0`, `tmux_pane_id TEXT`, `claude_ui_pid INTEGER`.

The `name` column is the human-readable identifier used as part of the 2-tuple identity key `(team, name)` — it MUST NOT be NULL and MUST NOT be empty after trimming. The `role` column remains a non-null informational field that describes the agent's function (e.g. `backend`, `frontend`) but is NOT part of the identity key; multiple successive registrations for the same `(team, name)` MAY carry different `role` values and MUST collapse to a single row. The `client` column stores the explicitly declared runtime kind (`codex`, `claude-code`, `opencode`, or `custom`) and MAY be NULL only for legacy rows written before this requirement. The `client_name` column is nullable and stores an optional free-form runtime label used only when `client='custom'`. The `tmux_pane_id` column remains nullable and stores an optional tmux pane identifier (e.g. `%42`).

The `claude_ui_pid` column is nullable and is populated only on `__channel_proxy__` rows; it stores the parent process id (`process.ppid`) of the channel proxy, which equals the Claude Code UI process id that spawned the proxy.  It enables the host-to-proxy match during `register_claude_self` / `register_agent({client:'claude-code'})` auto-bind (see the "register_claude_self auto-binds channel_session_id via ui_pid match" requirement).  For non-proxy rows it MUST remain NULL.

A UNIQUE index `agents_identity_idx` SHALL exist on `(team, name)` to support O(log n) identity lookup AND to physically prevent multiple rows with the same `(team, name)`.

On daemon startup, when the `agents` table is missing the `claude_ui_pid` column, the daemon SHALL execute an additive migration `ALTER TABLE agents ADD COLUMN claude_ui_pid INTEGER` in a single transaction; the migration is idempotent (if the column already exists, no ALTER is issued) and MUST NOT backfill values (existing rows get NULL until their next `register_agent` upsert).

#### Scenario: Fresh database creates UNIQUE identity index on (team, name)

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA index_list('agents')` contains `agents_identity_idx`
- **AND** `PRAGMA index_info('agents_identity_idx')` lists exactly two columns in order: `team`, `name`
- **AND** `PRAGMA index_list('agents')` shows `agents_identity_idx` with `unique = 1`

#### Scenario: agents table columns match schema

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA table_info('agents')` lists columns: `agent_id`, `client`, `client_name`, `team`, `role`, `name`, `model`, `registered_at`, `last_seen_at`, `last_processed_event_id`, `tmux_pane_id`, `claude_ui_pid`
- **AND** the `tmux_pane_id` column exists with type `TEXT` and `notnull = 0`
- **AND** the `claude_ui_pid` column exists with type `INTEGER` and `notnull = 0`
- **AND** the `name` column has `notnull = 1`
- **AND** the `role` column has `notnull = 1`

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

## ADDED Requirements

### Requirement: register_agent accepts claude_ui_pid only for __channel_proxy__ callers

The `register_agent` MCP tool SHALL accept an optional `claude_ui_pid: integer` field.  When the field is provided:

1. The `role` field on the same call MUST equal `'__channel_proxy__'`; otherwise the tool SHALL reject at the schema layer as an invalid field combination (the same error class as existing gated fields).
2. The value MUST be a positive integer; non-integer or non-positive values are rejected at the schema layer.
3. On UPSERT, `claude_ui_pid` is written to the corresponding column on the proxy's agents row.  On re-registration (same `(team, name)` identity) the value is overwritten if the new call supplies it, and preserved otherwise.

For all `role != '__channel_proxy__'` callers, the tool SHALL reject the `claude_ui_pid` key as unrecognized.

#### Scenario: proxy registration persists claude_ui_pid

- **GIVEN** a caller invokes `register_agent({client:'custom', role:'__channel_proxy__', name:'channel-proxy-27245', team:'default', model:'proxy', claude_ui_pid:25424, delivery:{kind:'claude-channel', channel_session_id:'csid-abc'}})`
- **WHEN** the tool completes successfully
- **THEN** the agents row has `claude_ui_pid=25424`
- **AND** the row's `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`

#### Scenario: non-proxy caller cannot supply claude_ui_pid

- **WHEN** a caller invokes `register_agent({client:'custom', role:'worker', name:'alice', model:'sonnet', claude_ui_pid:25424})`
- **THEN** the call is rejected at the schema layer
- **AND** no row is inserted or updated

#### Scenario: claude_ui_pid must be a positive integer

- **WHEN** a caller invokes `register_agent({client:'custom', role:'__channel_proxy__', name:'proxy-1', model:'proxy', claude_ui_pid:0})`
- **THEN** the call is rejected at the schema layer

#### Scenario: omitted claude_ui_pid preserves existing value

- **GIVEN** the agents table contains `(default, channel-proxy-27245)` with `claude_ui_pid=25424`
- **WHEN** a new session re-registers the same identity without supplying `claude_ui_pid`
- **THEN** the row's `claude_ui_pid` is still `25424` (preserved, not NULL-ified)

### Requirement: register_claude_self auto-binds channel_session_id via ui_pid match

When `register_claude_self` is invoked AND the caller supplies `ui_pid` AND the caller does NOT supply `channel_session_id`, the daemon SHALL, after completing the identity UPSERT and any automatic runtime binding, perform a best-effort auto-bind of `delivery.kind='claude-channel'`:

1. Persist the caller's `ui_pid` onto the identity row as `runtime_ui_pid` (this already happens during ui_pid-based automatic runtime binding; when that path is skipped — e.g. tmux detection fails or already converged without ui_pid — the value MUST still be persisted on the row so auto-bind can subsequently find it).
2. Query: find a row where `role='__channel_proxy__'` AND `claude_ui_pid = <caller ui_pid>` AND `last_seen_at > now() - 5 minutes`, ordered by `last_seen_at DESC` with `LIMIT 1`.  The query MUST also filter by the caller's effective team (same team as the caller's identity row).
3. If no row matches, no action is taken — the caller's delivery is left as its existing value (typically `'none'`).
4. If a row matches, extract `channel_session_id` from `delivery_payload`.  If the csid also has a live `ChannelWakeFanout` sink attached in-memory, write the caller's `delivery_kind='claude-channel'` and `delivery_payload=json_object('channel_session_id', <csid>)` and include `channel_session_id: <csid>` in the response envelope.  If the sink is not live, skip the write and behave as if no row matched.

This auto-bind path runs after the caller's identity row exists, before the response is returned.  It is best-effort: failures or non-matches MUST NOT fail the `register_claude_self` call.

If the caller explicitly supplies `channel_session_id`, the existing explicit-bind path (identical to `bind_channel` semantics) MUST continue to run, and the auto-bind path MUST NOT be attempted.

#### Scenario: register_claude_self auto-binds when proxy row exists for same ui_pid

- **GIVEN** a `__channel_proxy__` row exists with `team='default'`, `claude_ui_pid=25424`, `delivery_kind='claude-channel'`, `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`, and a live `ChannelWakeFanout` sink under `'csid-abc'`
- **WHEN** a caller invokes `register_claude_self({name:'opus', project_dir:'/Users/jt/workspace/cross-agent-teams-mcp', ui_pid:25424})` (no `channel_session_id`)
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`
- **AND** the caller's `runtime_ui_pid` is `25424`

#### Scenario: register_claude_self without ui_pid does NOT auto-bind

- **GIVEN** a `__channel_proxy__` row exists for some proxy
- **WHEN** a caller invokes `register_claude_self({name:'opus', project_dir:'/Users/jt/workspace/cross-agent-teams-mcp'})` with no `ui_pid`
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='none'`

#### Scenario: register_claude_self with no matching proxy leaves delivery at none

- **GIVEN** no `__channel_proxy__` row has `claude_ui_pid=99999`
- **WHEN** a caller invokes `register_claude_self({name:'opus', ui_pid:99999})`
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='none'`

#### Scenario: register_claude_self skips auto-bind when proxy row's sink is dead

- **GIVEN** a `__channel_proxy__` row exists with `claude_ui_pid=25424` and `delivery.channel_session_id='csid-abc'`
- **AND** no `ChannelWakeFanout` sink is attached under `'csid-abc'` (the proxy's MCP session closed)
- **WHEN** a caller invokes `register_claude_self({name:'opus', ui_pid:25424})`
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='none'` (no stale csid bound)

#### Scenario: explicit channel_session_id bypasses auto-bind entirely

- **GIVEN** a `__channel_proxy__` row exists with `claude_ui_pid=25424` and `delivery.channel_session_id='csid-abc'` (live sink)
- **WHEN** a caller invokes `register_claude_self({name:'opus', ui_pid:25424, channel_session_id:'csid-explicit'})` and `'csid-explicit'` has a live sink attached
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_payload='{\"channel_session_id\":\"csid-explicit\"}'` (explicit value wins, auto-bind did not run)

#### Scenario: auto-bind is scoped to the caller's team

- **GIVEN** a `__channel_proxy__` row exists with `team='alpha'`, `claude_ui_pid=25424`, `delivery.channel_session_id='csid-alpha'`
- **WHEN** a caller invokes `register_claude_self({name:'opus', team:'default', ui_pid:25424})`
- **THEN** the caller's agents row is created in team `default` with `delivery_kind='none'` (no match because proxy's team differs)

### Requirement: register_agent client=claude-code auto-binds channel_session_id via ui_pid match

The auto-bind path described in the `register_claude_self auto-binds channel_session_id via ui_pid match` requirement SHALL additionally apply to `register_agent({client:'claude-code', ui_pid, ...})` calls that do not supply `channel_session_id` via the `delivery` field or a top-level csid argument.  Callers with other client kinds (`codex`, `opencode`, `custom`) are NOT affected by auto-bind.

#### Scenario: register_agent with client=claude-code and ui_pid auto-binds

- **GIVEN** a live `__channel_proxy__` row with `claude_ui_pid=25424` and `delivery.channel_session_id='csid-abc'` (live sink)
- **WHEN** a caller invokes `register_agent({client:'claude-code', name:'opus', model:'opus-4-7', ui_pid:25424, project_dir:'/Users/jt/workspace/cross-agent-teams-mcp'})` (no `delivery` field)
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`

#### Scenario: register_agent with client=codex does NOT auto-bind

- **GIVEN** a live `__channel_proxy__` row with `claude_ui_pid=25424` and `delivery.channel_session_id='csid-abc'` (live sink)
- **WHEN** a caller invokes `register_agent({client:'codex', name:'gpt', model:'gpt-5', ui_pid:25424, ...})`
- **THEN** the call succeeds
- **AND** the caller's agents row has its codex-specific delivery (or `delivery_kind='none'` if no codex delivery supplied) — it MUST NOT be set to `claude-channel`

### Requirement: runtime_ui_pid persisted on register_claude_self and register_agent client=claude-code

When either `register_claude_self` or `register_agent({client:'claude-code'})` is invoked with `ui_pid`, the daemon SHALL persist that value to the caller's `agents.runtime_ui_pid` column regardless of whether automatic tmux runtime binding converged.  This makes `runtime_ui_pid` available to the reactive-rebind path (`claude-channel-transport`: "Proxy registration triggers reactive rebind of matching hosts") even in deployments where tmux binding was bypassed or failed.

#### Scenario: runtime_ui_pid persisted even when tmux detection does not converge

- **GIVEN** a caller invokes `register_claude_self({name:'opus', ui_pid:25424})`
- **AND** tmux pane detection returns `not_found`
- **WHEN** the tool completes successfully
- **THEN** the caller's agents row has `runtime_ui_pid=25424`
- **AND** the `tmux_pane_id` column is NULL

#### Scenario: runtime_ui_pid overwritten on subsequent re-registration with new ui_pid

- **GIVEN** agent `(default, opus)` already exists with `runtime_ui_pid=111`
- **WHEN** a new MCP session invokes `register_claude_self({name:'opus', ui_pid:222})`
- **THEN** the row's `runtime_ui_pid` is now `222`
