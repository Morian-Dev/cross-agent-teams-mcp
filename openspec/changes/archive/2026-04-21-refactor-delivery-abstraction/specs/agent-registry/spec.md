## ADDED Requirements

### Requirement: Agents table includes delivery_kind and delivery_payload columns

The `agents` table SHALL include two additional columns for persisting the agent's `DeliverySpec` (see `agent-delivery/spec.md`): `delivery_kind TEXT NOT NULL DEFAULT 'none'` and `delivery_payload TEXT` (nullable; stores a JSON string when non-null).  These two columns together are the authoritative storage for the delivery channel.  `delivery_kind` defaults to `'none'` so that rows inserted by any code path that has not yet been updated to supply delivery remain valid.

#### Scenario: Fresh database creates agents table with delivery_kind and delivery_payload columns

- **WHEN** the daemon bootstraps a fresh database
- **THEN** `PRAGMA table_info('agents')` lists a column named `delivery_kind` with type `TEXT`, `notnull = 1`, and default value `'none'`
- **AND** `PRAGMA table_info('agents')` lists a column named `delivery_payload` with type `TEXT` and `notnull = 0`
- **AND** rows inserted without providing delivery fields have `delivery_kind='none'` and `delivery_payload IS NULL`

### Requirement: Startup migration adds delivery columns and backfills from channel_session_id

On daemon startup, when the `agents` table is missing the `delivery_kind` or `delivery_payload` columns, the daemon SHALL execute an additive migration in a single transaction:

1. `ALTER TABLE agents ADD COLUMN delivery_kind TEXT NOT NULL DEFAULT 'none'` (if missing)
2. `ALTER TABLE agents ADD COLUMN delivery_payload TEXT` (if missing)
3. `UPDATE agents SET delivery_kind='claude-channel', delivery_payload=json_object('channel_session_id', channel_session_id) WHERE channel_session_id IS NOT NULL AND delivery_kind='none'`

The migration MUST be idempotent: if both columns already exist, no ALTER is issued; the UPDATE SHALL only affect rows whose `channel_session_id` is non-null AND `delivery_kind` is still the default `'none'`.  The migration MUST NOT modify the legacy `channel_session_id` column.

#### Scenario: Startup migration on old schema adds both columns

- **GIVEN** an existing `data.db` where `agents` table lacks `delivery_kind` and `delivery_payload` columns
- **WHEN** the daemon starts
- **THEN** both columns are added with their declared types and defaults

#### Scenario: Startup migration backfills claude-channel rows

- **GIVEN** an existing `agents` row with `channel_session_id='csid-abc'` and no `delivery_*` columns yet
- **WHEN** the daemon starts and the migration completes
- **THEN** the row has `delivery_kind='claude-channel'` and `delivery_payload='{"channel_session_id":"csid-abc"}'`

#### Scenario: Startup migration is idempotent

- **GIVEN** the daemon has already migrated the database in a previous run
- **WHEN** the daemon starts again
- **THEN** no ALTER statements are issued
- **AND** no existing `delivery_kind`/`delivery_payload` values are overwritten

#### Scenario: Startup migration leaves channel_session_id column untouched

- **GIVEN** the migration runs against an old schema
- **WHEN** the migration completes
- **THEN** every row's original `channel_session_id` value is unchanged

### Requirement: register_agent accepts optional delivery field

The `register_agent` MCP tool SHALL accept an optional `delivery: DeliverySpec` field in its input.  When omitted, the tool behaves as before and persists `delivery_kind='none'`, `delivery_payload=NULL` on insert (or leaves existing delivery untouched on an idempotent re-registration).  When provided, the tool validates it via the `agent-delivery` write validator (see `agent-delivery/spec.md`) and persists `delivery_kind` / `delivery_payload` in the same transaction that writes the identity row.

Validation failures SHALL return `{error: 'invalid_delivery', reason: ...}` without writing any row.

#### Scenario: register_agent without delivery preserves existing default behavior

- **GIVEN** a fresh MCP session calling `register_agent({team: 'default', name: 'alice', model: 'sonnet'})` with no `delivery` field
- **WHEN** the tool returns successfully
- **THEN** the `agents` row for alice has `delivery_kind='none'` and `delivery_payload IS NULL`

#### Scenario: register_agent with delivery kind 'claude-channel' persists both columns atomically

- **GIVEN** a caller supplies `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}` alongside identity fields
- **WHEN** the tool returns successfully
- **THEN** the `agents` row has both the identity fields AND `delivery_kind='claude-channel'` AND `delivery_payload='{"channel_session_id":"csid-abc"}'`

#### Scenario: register_agent with invalid delivery rejects without inserting

- **GIVEN** a caller supplies `delivery={kind: 'claude-channel'}` (missing channel_session_id) for a not-yet-registered (team, name)
- **WHEN** the tool is invoked
- **THEN** the tool returns `{error: 'invalid_delivery', reason: 'missing_channel_session_id'}`
- **AND** no `agents` row is created for that (team, name)

### Requirement: list_agents returns delivery field

`list_agents` response entries SHALL include a `delivery: DeliverySpec` field reflecting the agent's reconstructed `DeliverySpec` (per `agent-delivery/spec.md` reconstruction rules).

#### Scenario: list_agents surfaces delivery for kind 'claude-channel'

- **GIVEN** team `default` has agent `alice` with `delivery_kind='claude-channel'` and `delivery_payload='{"channel_session_id":"csid-abc"}'`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `alice` has `delivery: {kind: 'claude-channel', channel_session_id: 'csid-abc'}`

#### Scenario: list_agents surfaces delivery kind 'none' for agents with no channel

- **GIVEN** team `default` has agent `bob` with `delivery_kind='none'` and `delivery_payload IS NULL`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `bob` has `delivery: {kind: 'none'}`

## MODIFIED Requirements

### Requirement: Agents table includes channel_session_id column

The `agents` table SHALL retain the existing nullable column `channel_session_id TEXT` for backward compatibility.  This column is now **legacy and read-only**: no code path in the daemon SHALL `INSERT` or `UPDATE` the `channel_session_id` column directly; the authoritative delivery state lives in `delivery_kind` / `delivery_payload` (see the ADDED requirement above).  The column remains in `PRAGMA table_info` output so that databases migrated from older daemons continue to round-trip through backup/restore.  Removing this column is deferred to a later change.

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

`list_agents` response entries SHALL continue to include a `channel_session_id: string | null` field for backward compatibility.  This field is now **derived** from `delivery` per the rule in `agent-delivery/spec.md`: it equals `delivery.channel_session_id` when `delivery.kind === 'claude-channel'`, and is `null` otherwise.  The field is no longer populated by reading the legacy column value directly.

#### Scenario: list_agents surfaces derived channel_session_id for claude-channel delivery

- **GIVEN** team `default` has agent `alice` with `delivery={kind: 'claude-channel', channel_session_id: 'csid-abc'}` and agent `bob` with `delivery={kind: 'none'}`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `alice` has `channel_session_id: 'csid-abc'`
- **AND** the entry for `bob` has `channel_session_id: null`

#### Scenario: list_agents returns null channel_session_id for non-claude delivery kinds

- **GIVEN** team `default` has an agent whose `delivery.kind` is anything other than `'claude-channel'` (e.g. `'none'` or a future kind)
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry has `channel_session_id: null`
