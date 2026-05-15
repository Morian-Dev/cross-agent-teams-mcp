## MODIFIED Requirements

### Requirement: Agents table schema

The database SHALL contain an `agents` table with columns: `agent_id TEXT PRIMARY KEY`, `agent_type TEXT`, `agent_type_name TEXT`, `device TEXT NOT NULL`, `team TEXT NOT NULL`, `role TEXT NOT NULL`, `name TEXT NOT NULL`, `model TEXT`, `registered_at TEXT NOT NULL`, `last_seen_at TEXT NOT NULL`, `last_processed_event_id INTEGER NOT NULL DEFAULT 0`, `tmux_pane_id TEXT`, `claude_ui_pid INTEGER`, `remote_addr TEXT`.

The `name` column is the human-readable identifier used as part of the 3-tuple identity key `(device, team, name)` — it MUST NOT be NULL, MUST NOT be empty after trimming, and MUST NOT contain the `:` character (the colon is reserved as the `name:device` syntax delimiter in the mailbox capability). The `device` column is the host-namespace identifier used as part of the same identity key — it MUST NOT be NULL, MUST NOT be empty after trimming, MUST NOT contain `:`, and MUST be 64 characters or fewer. The `role` column remains a non-null informational field that describes the agent's function (e.g. `backend`, `frontend`) but is NOT part of the identity key; multiple successive registrations for the same `(device, team, name)` MAY carry different `role` values and MUST collapse to a single row. The `agent_type` column stores the explicitly declared runtime kind (`codex`, `claude-code`, `opencode`, or `custom`) and MAY be NULL only for legacy rows written before this requirement. The `agent_type_name` column is nullable and stores an optional free-form runtime label used only when `agent_type='custom'`. The `tmux_pane_id` column remains nullable and stores an optional tmux pane identifier (e.g. `%42`).

The `claude_ui_pid` column is nullable and is populated only on `__channel_proxy__` rows; it stores the parent process id (`process.ppid`) of the channel proxy, which equals the Claude Code UI process id that spawned the proxy. It enables the host-to-proxy match during `register_agent({agent_type:'claude-code'})` auto-bind. For non-proxy rows it MUST remain NULL. The `remote_addr` column is nullable and stores the peer address of the MCP session that wrote the row when that session was non-loopback (used for daemon-internal audit only); for loopback sessions and legacy rows it MUST be NULL. Neither `claude_ui_pid` nor `remote_addr` is part of the identity key.

A UNIQUE index `agents_identity_idx` SHALL exist on `(device, team, name)` to support O(log n) identity lookup AND to physically prevent multiple rows with the same `(device, team, name)`.

On daemon startup, when the `agents` table is missing the `claude_ui_pid` column, the daemon SHALL execute an additive migration `ALTER TABLE agents ADD COLUMN claude_ui_pid INTEGER` in a single transaction; the migration is idempotent (if the column already exists, no ALTER is issued) and MUST NOT backfill values (existing rows get NULL until their next `register_agent` upsert). When the `agents` table is missing the `device` column, the daemon SHALL execute an additive migration that (1) `ALTER TABLE agents ADD COLUMN device TEXT`, (2) `UPDATE agents SET device = :local_device WHERE device IS NULL` where `:local_device` is the daemon's configured `--device` value (or its default `os.hostname()`-derived label), and (3) `DROP INDEX IF EXISTS agents_identity_idx; CREATE UNIQUE INDEX agents_identity_idx ON agents(device, team, name)` — all within a single transaction. The same startup pass SHALL also `ALTER TABLE agents ADD COLUMN remote_addr TEXT` when that column is missing (no backfill). The combined migration MUST be idempotent — repeated daemon startups MUST NOT re-run completed ALTERs. Before backfilling `device`, the daemon SHALL verify no existing row has a `name` containing `:`; if any such row exists the migration MUST fail with a clear error referencing the offending `(team, name)`. The column-rename migration covering `client → agent_type` and `client_name → agent_type_name` is described in a separate requirement.

#### Scenario: Fresh database creates UNIQUE identity index on (device, team, name)

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA index_list('agents')` contains `agents_identity_idx`
- **AND** `PRAGMA index_info('agents_identity_idx')` lists exactly three columns in order: `device`, `team`, `name`
- **AND** `PRAGMA index_list('agents')` shows `agents_identity_idx` with `unique = 1`

#### Scenario: agents table columns match schema

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA table_info('agents')` lists columns: `agent_id`, `agent_type`, `agent_type_name`, `device`, `team`, `role`, `name`, `model`, `registered_at`, `last_seen_at`, `last_processed_event_id`, `tmux_pane_id`, `claude_ui_pid`, `remote_addr`
- **AND** the `tmux_pane_id` column exists with type `TEXT` and `notnull = 0`
- **AND** the `claude_ui_pid` column exists with type `INTEGER` and `notnull = 0`
- **AND** the `device` column exists with type `TEXT` and `notnull = 1`
- **AND** the `remote_addr` column exists with type `TEXT` and `notnull = 0`
- **AND** the `name` column has `notnull = 1`
- **AND** the `role` column has `notnull = 1`
- **AND** neither `client` nor `client_name` appears in the column list

#### Scenario: Inserting two rows with same (device, team, name) violates UNIQUE constraint

- **GIVEN** a fresh `agents` table with one row `(device='host-a', team='default', name='alice', role='backend', agent_id='X')`
- **WHEN** a second INSERT is attempted with `(device='host-a', team='default', name='alice', role='frontend', agent_id='Y')`
- **THEN** SQLite raises `UNIQUE constraint failed: agents.device, agents.team, agents.name`
- **AND** only the original row `agent_id='X'` remains in the table

#### Scenario: Same (team, name) coexists across distinct devices

- **GIVEN** an `agents` table with one row `(device='host-a', team='default', name='creator', agent_id='X')`
- **WHEN** an INSERT writes `(device='host-b', team='default', name='creator', agent_id='Y')`
- **THEN** both rows persist (different devices ⇒ different identity tuples)
- **AND** `SELECT agent_id FROM agents WHERE team='default' AND name='creator' ORDER BY device` returns `['X', 'Y']`

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

#### Scenario: Startup migration adds device, backfills, and rebuilds identity index

- **GIVEN** an existing `data.db` where `agents` table lacks the `device` column and contains rows with various `(team, name)` values, none of which contain `:` in `name`
- **AND** the daemon is started with `--device host-a` (or default-derived label `host-a`)
- **WHEN** the daemon starts
- **THEN** the migration issues `ALTER TABLE agents ADD COLUMN device TEXT`
- **AND** the migration issues `ALTER TABLE agents ADD COLUMN remote_addr TEXT`
- **AND** every pre-existing row has `device = 'host-a'` after the run
- **AND** `agents_identity_idx` now covers exactly `(device, team, name)` in that order with `unique = 1`
- **AND** the entire migration runs inside a single transaction

#### Scenario: Startup migration is idempotent for device and remote_addr

- **GIVEN** the daemon has already migrated the database in a previous run so `device` and `remote_addr` exist and the identity index already covers `(device, team, name)`
- **WHEN** the daemon starts again
- **THEN** no ALTER statement is issued for `device` or `remote_addr`
- **AND** the existing `agents_identity_idx` is NOT dropped or recreated

#### Scenario: Startup migration aborts when an existing name contains a colon

- **GIVEN** an existing `data.db` where one row has `name='odd:name'`
- **WHEN** the daemon starts (and the `device` column is missing so migration would run)
- **THEN** the migration aborts before backfilling `device`
- **AND** the daemon exits with a non-zero status
- **AND** stderr names the offending `(team, name)` so the operator can fix the row

### Requirement: list_agents scoped to caller team

The `list_agents` MCP tool SHALL take `{ team?: string }` (defaults to caller's team) and return `{ agents: Array<{ agent_id, agent_type?, agent_type_name?, device, role, name, model?, tmux_pane_id?, last_seen_at, online: boolean }> }`. `online` MUST be true when `last_seen_at` is within the last 5 minutes. Agents from other teams MUST NOT appear, but agents from every device within the resolved team SHALL appear so the caller can compose `name:device` addresses for cross-device recipients. The `name` field is always present and non-empty. The `device` field is always present and non-empty. The `tmux_pane_id` field MUST be present in every agent entry; its value is the persisted pane id (string) or `null` if unset. `agent_type_name` SHALL be `null` unless `agent_type='custom'`. The response object MUST NOT contain legacy `client` or `client_name` keys, and MUST NOT contain `remote_addr` or any user-facing `origin` field — `device` is the only namespace identifier visible to callers.

Rows with `role='__channel_proxy__'` MUST NOT appear in the response. Channel proxy rows are internal infrastructure for the `claude-channel` delivery path; they are not legitimate `send_message` recipients and have no place in the public team listing. The exclusion is unconditional — there is no opt-in flag to surface them — and applies even when the caller itself is a channel proxy. Internal lookup paths (`AgentsRepo.getById`, channel-wake fanout, delivery dispatch) are unaffected and continue to see channel proxy rows directly.

#### Scenario: list_agents returns one row per device for shared (team, name)

- **GIVEN** the caller is in team `foo` on device `host-a`
- **AND** the `agents` table contains `(device='host-a', team='foo', name='creator', role='default')` and `(device='host-b', team='foo', name='creator', role='default')`
- **WHEN** the caller calls `list_agents()` (no `team` arg)
- **THEN** the response `agents` array contains two entries with `name='creator'`
- **AND** one entry has `device='host-a'` and the other has `device='host-b'`
- **AND** neither entry contains a `remote_addr` field or an `origin` field

#### Scenario: list_agents excludes other teams across all devices

- **GIVEN** the caller is in team `foo`
- **AND** the `agents` table contains `(device='host-b', team='bar', name='creator')`
- **WHEN** the caller calls `list_agents()`
- **THEN** the `bar`-team entry MUST NOT appear, regardless of its device

#### Scenario: list_agents response includes device field on every entry

- **GIVEN** the `agents` table contains one row `(device='host-a', team='default', name='alice')`
- **WHEN** the caller in team `default` calls `list_agents()`
- **THEN** every entry in `agents[]` has a `device` field of type `string` with length ≥ 1

### Requirement: register_agent agent_type=claude-code auto-binds channel_session_id via ui_pid match

When `register_agent({agent_type:'claude-code', ui_pid, ...})` is invoked AND the caller does NOT supply `channel_session_id` via the `delivery` field or any top-level csid argument, the daemon SHALL, after completing the identity UPSERT and any automatic runtime binding, perform a best-effort auto-bind of `delivery.kind='claude-channel'`:

1. Persist the caller's `ui_pid` onto the identity row as `runtime_ui_pid` (this already happens during ui_pid-based automatic runtime binding; when that path is skipped — e.g. tmux detection fails or already converged without ui_pid — the value MUST still be persisted on the row so auto-bind can subsequently find it).
2. Query: find a row where `role='__channel_proxy__'` AND `device = <caller.device>` AND `claude_ui_pid = <caller ui_pid>` AND `last_seen_at > now() - 5 minutes`, ordered by `last_seen_at DESC` with `LIMIT 1`. The query MUST filter by `device` to disambiguate PID collisions across hosts: PIDs are not unique across machines, so a `(device, claude_ui_pid)` match is required to identify the correct proxy. The query MUST NOT filter by team: the channel proxy always registers into `team='default'` per the `claude-channel-transport` startup sequence, while Claude Code hosts typically register into a project-derived team, so a team filter would prevent auto-bind in the common case.
3. If no row matches, no action is taken — the caller's delivery is left as its existing value (typically `'none'`).
4. If a row matches, extract `channel_session_id` from `delivery_payload`. If the csid also has a live `ChannelWakeFanout` sink attached in-memory, write the caller's `delivery_kind='claude-channel'` and `delivery_payload=json_object('channel_session_id', <csid>)` and include `channel_session_id: <csid>` in the response envelope. If the sink is not live, skip the write and behave as if no row matched.

This auto-bind path runs after the caller's identity row exists, before the response is returned. It is best-effort: failures or non-matches MUST NOT fail the `register_agent` call.

If the caller explicitly supplies `channel_session_id` (via `delivery.channel_session_id` or any top-level csid argument), the existing explicit-bind path (identical to `bind_channel` semantics) MUST continue to run, and the auto-bind path MUST NOT be attempted.

Callers with other agent types (`codex`, `opencode`, `custom`) are NOT affected by auto-bind — only `agent_type='claude-code'` triggers it.

#### Scenario: register_agent with agent_type=claude-code and ui_pid auto-binds when proxy row exists on same device

- **GIVEN** a `__channel_proxy__` row exists with `device='host-b'`, `team='default'`, `claude_ui_pid=25424`, `delivery_kind='claude-channel'`, `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`, and a live `ChannelWakeFanout` sink under `'csid-abc'`
- **WHEN** a caller from device `host-b` invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', project_dir:'/Users/host-b/workspace/foo', ui_pid:25424})` (no `channel_session_id`)
- **THEN** the call succeeds
- **AND** the caller's agents row has `device='host-b'`, `delivery_kind='claude-channel'`, and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`
- **AND** the caller's `runtime_ui_pid` is `25424`

#### Scenario: auto-bind does NOT cross devices when PIDs collide

- **GIVEN** a `__channel_proxy__` row exists with `device='host-a'`, `claude_ui_pid=25424`, live `delivery.channel_session_id='csid-host-a'`
- **AND** no `__channel_proxy__` row exists with `device='host-b'`
- **WHEN** a caller from device `host-b` invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:25424})`
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='none'` (the `device='host-a'` proxy MUST NOT match a `device='host-b'` caller despite the matching PID)

#### Scenario: register_agent with agent_type=claude-code without ui_pid does NOT auto-bind

- **GIVEN** a `__channel_proxy__` row exists for some proxy
- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', project_dir:'/Users/host-a/workspace/cross-agent-teams-mcp'})` with no `ui_pid`
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='none'`

#### Scenario: register_agent with agent_type=claude-code and no matching proxy leaves delivery at none

- **GIVEN** no `__channel_proxy__` row has `device='host-a'` AND `claude_ui_pid=99999`
- **WHEN** a caller from device `host-a` invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:99999})`
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='none'`

#### Scenario: register_agent with agent_type=claude-code skips auto-bind when proxy row's sink is dead

- **GIVEN** a `__channel_proxy__` row exists with `device='host-a'`, `claude_ui_pid=25424`, and `delivery.channel_session_id='csid-abc'`
- **AND** no `ChannelWakeFanout` sink is attached under `'csid-abc'` (the proxy's MCP session closed)
- **WHEN** a caller from device `host-a` invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:25424})`
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='none'` (no stale csid bound)

#### Scenario: explicit channel_session_id bypasses auto-bind entirely on register_agent

- **GIVEN** a `__channel_proxy__` row exists with `device='host-a'`, `claude_ui_pid=25424`, and `delivery.channel_session_id='csid-abc'` (live sink)
- **WHEN** a caller from device `host-a` invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:25424, channel_session_id:'csid-explicit'})` and `'csid-explicit'` has a live sink attached
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_payload='{\"channel_session_id\":\"csid-explicit\"}'` (explicit value wins, auto-bind did not run)

#### Scenario: auto-bind ignores team: proxy row in team A still matches caller in team B on same device

- **GIVEN** a `__channel_proxy__` row exists with `device='host-a'`, `team='default'`, `claude_ui_pid=25424`, `delivery.channel_session_id='csid-abc'`, and a live `ChannelWakeFanout` sink under `'csid-abc'`
- **WHEN** a caller from device `host-a` invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', team:'alpha', ui_pid:25424})`
- **THEN** the caller's agents row is created in team `alpha` with `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'` (proxy team `default` does NOT block the match; the `(device, claude_ui_pid)` pair uniquely identifies the caller's proxy)

#### Scenario: register_agent with agent_type=codex does NOT auto-bind

- **GIVEN** a live `__channel_proxy__` row with `device='host-a'`, `claude_ui_pid=25424`, and `delivery.channel_session_id='csid-abc'` (live sink)
- **WHEN** a caller from device `host-a` invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:'<uuid>', ui_pid:25424})`
- **THEN** the call succeeds
- **AND** the caller's agents row has its codex-specific delivery (or `delivery_kind='none'` if no codex delivery supplied) — it MUST NOT be set to `claude-channel`

## ADDED Requirements

### Requirement: register_agent accepts and enforces device per origin

The `register_agent` MCP tool SHALL accept an optional `device: string` argument and SHALL resolve the row's effective `device` value based on the session's `origin` tag (set by `mcp-transport`):

- When `origin = 'local'` (loopback session): if the caller supplied `device` and it equals the daemon's configured local device label, the value is accepted; if it was supplied and differs from the local label, the daemon SHALL return `{ error: 'device_spoofing_from_loopback' }`; if it was omitted, the daemon SHALL auto-fill `device` with the local label.
- When `origin = 'remote'` (non-loopback session): the caller MUST supply a non-empty `device`. Missing or empty returns `{ error: 'device_required_from_remote' }`. If the supplied value equals the local label, the daemon SHALL return `{ error: 'device_spoofing_local_label_from_remote' }`. If the value contains `:` or exceeds 64 characters, the daemon SHALL return `{ error: 'invalid_device_label' }`.

The `name` field SHALL additionally be rejected with `{ error: 'invalid_name_label' }` when it contains the `:` character (regardless of origin). All other existing `register_agent` validations (delivery, claude_ui_pid, agent_type, etc.) continue to apply unchanged. When the session's `origin` is `'remote'` and the row is successfully written, the daemon SHALL persist the session's peer address in the `remote_addr` column; for `origin='local'` rows `remote_addr` MUST remain NULL.

These error codes are wire-stable. They are returned in the same `{ error: ... }` envelope shape used by existing `register_agent` validation errors and MUST NOT block other unrelated arguments from validation reports when more than one rule is violated (existing precedence rules apply: the first violation in the daemon's check order wins, matching prior behavior for `agent_id_collision` etc.).

#### Scenario: loopback caller omits device — daemon fills local label

- **GIVEN** the daemon is started with `--device host-a`
- **AND** an MCP session was established via loopback (`origin='local'`)
- **WHEN** the caller invokes `register_agent({agent_type:'claude-code', name:'creator', model:'opus-4-7'})` (no `device`)
- **THEN** the call succeeds
- **AND** the persisted row has `device='host-a'`
- **AND** `remote_addr IS NULL`

#### Scenario: loopback caller supplies matching device — accepted

- **GIVEN** the daemon is started with `--device host-a`
- **WHEN** a loopback caller invokes `register_agent({agent_type:'claude-code', name:'creator', model:'opus-4-7', device:'host-a'})`
- **THEN** the call succeeds
- **AND** the persisted row has `device='host-a'`

#### Scenario: loopback caller spoofs another device — rejected

- **GIVEN** the daemon is started with `--device host-a`
- **WHEN** a loopback caller invokes `register_agent({agent_type:'claude-code', name:'creator', model:'opus-4-7', device:'host-b'})`
- **THEN** the response is `{ error: 'device_spoofing_from_loopback' }`
- **AND** no row is written

#### Scenario: remote caller omits device — rejected

- **GIVEN** the daemon is started with `--host 0.0.0.0 --token T --device host-a`
- **AND** an MCP session was established from a non-loopback peer (`origin='remote'`)
- **WHEN** the caller invokes `register_agent({agent_type:'claude-code', name:'creator', model:'opus-4-7'})` (no `device`)
- **THEN** the response is `{ error: 'device_required_from_remote' }`
- **AND** no row is written

#### Scenario: remote caller claims local label — rejected

- **GIVEN** the daemon is started with `--device host-a`
- **AND** an MCP session was established from a non-loopback peer
- **WHEN** the caller invokes `register_agent({agent_type:'claude-code', name:'creator', model:'opus-4-7', device:'host-a'})`
- **THEN** the response is `{ error: 'device_spoofing_local_label_from_remote' }`
- **AND** no row is written

#### Scenario: remote caller supplies its own device — accepted and remote_addr recorded

- **GIVEN** the daemon is started with `--device host-a`
- **AND** an MCP session was established from a non-loopback peer at `10.0.0.42`
- **WHEN** the caller invokes `register_agent({agent_type:'claude-code', name:'creator', model:'opus-4-7', device:'host-b'})`
- **THEN** the call succeeds
- **AND** the persisted row has `device='host-b'`
- **AND** the persisted row has `remote_addr='10.0.0.42'`

#### Scenario: device label containing colon is rejected from remote

- **GIVEN** a remote session
- **WHEN** the caller invokes `register_agent({agent_type:'claude-code', name:'creator', model:'opus-4-7', device:'has:colon'})`
- **THEN** the response is `{ error: 'invalid_device_label' }`

#### Scenario: device label exceeding 64 characters is rejected

- **GIVEN** a remote session
- **AND** a 65-character device value (e.g. 65 lowercase letters)
- **WHEN** the caller invokes `register_agent({..., device: '<65-char string>'})`
- **THEN** the response is `{ error: 'invalid_device_label' }`

#### Scenario: name containing colon is rejected regardless of origin

- **GIVEN** any MCP session (loopback or remote)
- **WHEN** the caller invokes `register_agent({agent_type:'claude-code', name:'bad:name', model:'opus-4-7'})`
- **THEN** the response is `{ error: 'invalid_name_label' }`
- **AND** no row is written
