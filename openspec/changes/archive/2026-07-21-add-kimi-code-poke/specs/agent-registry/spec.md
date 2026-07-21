## MODIFIED Requirements

### Requirement: register_agent tool description contains DETECTION block for agent types

The `register_agent` MCP tool description SHALL contain a clearly marked DETECTION block instructing LLM callers to determine `agent_type` by running a sequence of mechanical probes against their tool shell environment, in order, with first-match-wins semantics. FOUR active probes SHALL be promoted; everything else falls through to a `agent_type="custom"` fallback:

1. `printenv KIMI_XATS_BASE_URL` non-empty → `agent_type='kimi-code'`; pass that value as `base_url`, and pass `session_id` from `printenv KIMI_XATS_SESSION_ID` (the `xats-kimi` launcher pre-creates the session via the kimi server REST API and exports BOTH variables; the id is exact — callers MUST NOT derive it from `~/.kimi-code/session_index.jsonl`, whose last `workDir` match can be a different kimi session in the same directory). `session_id` is REQUIRED for kimi-code — the daemon does NOT auto-resolve it. The env vars are set ONLY by the `xats-kimi` launcher, so their presence is itself the runtime assertion that the caller is kimi-code.
2. `printenv OPENCODE_XATS_BASE_URL` non-empty → `agent_type='opencode'`; pass that value as `base_url`. Do NOT pass `session_id` — the daemon auto-resolves it as the most recently updated session on that base_url. The env var is set ONLY by the `free-xats-opencode` launcher, so its presence is itself the runtime assertion that the caller is opencode.
3. `printenv CODEX_THREAD_ID` non-empty → `agent_type='codex'`, pass that value as `thread_id` (REQUIRED for codex per the Zod refinement); do NOT pass `ui_pid` (the launcher's `pre_register_codex_pane` flow handles tmux pane binding and supplying `ui_pid` from codex disables that path).
4. `printenv CLAUDECODE` non-empty OR `printenv CLAUDE_CODE_ENTRYPOINT` non-empty → `agent_type='claude-code'`; pass `$PPID` as `ui_pid` to enable channel auto-bind.
5. None of the above → `agent_type='custom'`, `agent_type_name=<the harness you are running under, e.g. cursor, ...>`. Detect the harness name from your runtime environment when you can — for example, `printenv CURSOR_TRACE_ID` non-empty is a cursor signal — but the DETECTION block MUST also explicitly warn against guessing agent type from system-wide signals like "binary X exists on PATH", because such probes detect what the user has installed, not what runtime the LLM is inside.

The DETECTION block's textual presence is the contract — implementers may reword the prose, but the description MUST contain:

- The five env-based probe signals `KIMI_XATS_BASE_URL`, `KIMI_XATS_SESSION_ID`, `OPENCODE_XATS_BASE_URL`, `CODEX_THREAD_ID`, and `CLAUDECODE` or `CLAUDE_CODE_ENTRYPOINT`.
- The `agent_type="custom"` fallback rule with the `agent_type_name` requirement.
- A reference to `CURSOR_TRACE_ID` (or equivalent) as an example of how to derive `agent_type_name` for cursor under the custom fallback — NOT as a separate active probe.
- An anti-pattern warning against system-wide probes (the literal phrase "PATH" appearing alongside language about installed binaries vs. runtime identity is sufficient).
- An explicit opencode branch that instructs callers to pass `agent_type='opencode'` with `base_url=$OPENCODE_XATS_BASE_URL`, and to OMIT `session_id` (daemon auto-resolves) unless the caller has an explicit override.
- An explicit kimi-code branch that instructs callers to pass `agent_type='kimi-code'` with `base_url=$KIMI_XATS_BASE_URL` and a REQUIRED `session_id` read from `$KIMI_XATS_SESSION_ID`.

The description MUST NOT contain the previously promoted active probe `command -v opencode` (or any other "binary X is on PATH" probe). The env-based probes are the ONLY sanctioned mechanisms for promoting `agent_type='opencode'` / `agent_type='kimi-code'`; PATH-based probes remain rejected because they assert runtime identity from system-wide state instead of session-local state.

#### Scenario: tools/list returns register_agent description containing KIMI_XATS_BASE_URL probe

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains the literal substring `KIMI_XATS_BASE_URL`
- **AND** that substring appears in the DETECTION block as the env-var probe for `agent_type='kimi-code'`

#### Scenario: tools/list returns register_agent description containing OPENCODE_XATS_BASE_URL probe

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains the literal substring `OPENCODE_XATS_BASE_URL`
- **AND** that substring appears in the DETECTION block as the env-var probe for `agent_type='opencode'`

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

The instructions string attached to the MCP `server.setInstructions` call SHALL describe registration in terms of `register_agent` only.  It MUST mention:

- `register_agent` as the single registration entry point.
- That `agent_type="kimi-code"` is selected when `KIMI_XATS_BASE_URL` is non-empty, and that callers pass that value as `base_url` plus a REQUIRED `session_id` read from `$KIMI_XATS_SESSION_ID`.
- That `agent_type="opencode"` is selected when `OPENCODE_XATS_BASE_URL` is non-empty, and that callers pass that value as `base_url` (daemon auto-resolves `session_id`).
- That `agent_type="codex"` requires `thread_id` from `$CODEX_THREAD_ID`.
- That `agent_type="claude-code"` should pass `$PPID` as `ui_pid` for channel auto-bind.
- That ANY other harness (cursor, an editor extension, an unknown caller) uses `agent_type="custom"` with `agent_type_name=<harness name>`.
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

#### Scenario: instructions mention OPENCODE_XATS_BASE_URL for opencode callers

- **WHEN** an MCP client fetches the server `instructions` during `initialize`
- **THEN** the `instructions` string contains the literal substring `OPENCODE_XATS_BASE_URL`

#### Scenario: instructions mention KIMI_XATS_BASE_URL for kimi-code callers

- **WHEN** an MCP client fetches the server `instructions` during `initialize`
- **THEN** the `instructions` string contains the literal substring `KIMI_XATS_BASE_URL`

#### Scenario: instructions mention agent_type=custom fallback

- **WHEN** an MCP client fetches the server `instructions` during `initialize`
- **THEN** the `instructions` string mentions `agent_type="custom"` (or equivalent quoting) AND `agent_type_name`

### Requirement: Agents table schema

The database SHALL contain an `agents` table with columns: `agent_id TEXT PRIMARY KEY`, `agent_type TEXT`, `agent_type_name TEXT`, `device TEXT NOT NULL`, `team TEXT NOT NULL`, `role TEXT NOT NULL`, `name TEXT NOT NULL`, `model TEXT`, `registered_at TEXT NOT NULL`, `last_seen_at TEXT NOT NULL`, `last_processed_event_id INTEGER NOT NULL DEFAULT 0`, `tmux_pane_id TEXT`, `claude_ui_pid INTEGER`, `remote_addr TEXT`.

The `name` column is the human-readable identifier used as part of the 3-tuple identity key `(device, team, name)` — it MUST NOT be NULL, MUST NOT be empty after trimming, and MUST NOT contain the `:` character (the colon is reserved as the `name:device` syntax delimiter in the mailbox capability). The `device` column is the host-namespace identifier used as part of the same identity key — it MUST NOT be NULL, MUST NOT be empty after trimming, MUST NOT contain `:`, and MUST be 64 characters or fewer. The `role` column remains a non-null informational field that describes the agent's function (e.g. `backend`, `frontend`) but is NOT part of the identity key; multiple successive registrations for the same `(device, team, name)` MAY carry different `role` values and MUST collapse to a single row. The `agent_type` column stores the explicitly declared runtime kind (`codex`, `claude-code`, `opencode`, `kimi-code`, or `custom`) and MAY be NULL only for legacy rows written before this requirement. The `agent_type_name` column is nullable and stores an optional free-form runtime label used only when `agent_type='custom'`. The `tmux_pane_id` column remains nullable and stores an optional tmux pane identifier (e.g. `%42`).

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

## ADDED Requirements

### Requirement: register_agent({agent_type:'kimi-code'}) validates inputs and writes kimi-server delivery

The daemon SHALL handle `register_agent({agent_type:'kimi-code'})` as a dedicated branch in `executeRegister`, mirroring the `opencode` branch. The following normative rules apply:

1. `base_url` MUST be a non-empty `http://` or `https://` URL. The Zod schema SHALL reject calls where `base_url` is missing, empty, or not parseable as an http/https URL, BEFORE any backend service runs and BEFORE any agents row is written or read.
2. `session_id` is REQUIRED. It MUST be a trimmed non-empty string (Zod rejection otherwise). Unlike opencode, the daemon MUST NOT auto-resolve `session_id` — kimi has no reliable "most recent session" semantic from inside a session, so the caller passes the exact id from `$KIMI_XATS_SESSION_ID` (exported by the `xats-kimi` launcher, which pre-creates the session via the kimi server REST API) per the DETECTION block.
3. `auth_token_ref` is OPTIONAL; when supplied it MUST be a trimmed non-empty string and is propagated verbatim into the persisted `delivery_payload`.
4. The daemon SHALL NOT perform a health check against the kimi server at registration time (the kimi server may be started later by `start-xats`; reachability failures surface at poke time as `kimi_connect_failed`).
5. On success, the daemon writes `delivery={kind:'kimi-server', session_id, base_url, auth_token_ref?}` on the caller's agents row via the `agent-delivery` persistence rules (`UPDATE agents SET delivery_kind='kimi-server', delivery_payload=...`).
6. The successful response envelope SHALL be `{ agent_id, team, session_id, base_url }`.
7. When `model` is omitted, the daemon SHALL persist `model = NULL` (no model-default inference, same as opencode).

The schema rejection error message for missing/malformed `base_url` or `session_id` SHOULD reference `KIMI_XATS_BASE_URL` / `KIMI_XATS_SESSION_ID` so an LLM that forgot to read its environment can self-correct.

#### Scenario: register_agent({agent_type:'kimi-code'}) writes kimi-server delivery

- **GIVEN** a caller invokes `register_agent({agent_type:'kimi-code', name:'kimi-1', team:'default', base_url:'http://127.0.0.1:58627', session_id:'session_abc'})`
- **WHEN** the call succeeds
- **THEN** the agents row is written with `delivery_kind='kimi-server'` and `delivery_payload='{"session_id":"session_abc","base_url":"http://127.0.0.1:58627"}'`
- **AND** the response is `{ agent_id: <uuid>, team: 'default', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627' }`

#### Scenario: register_agent({agent_type:'kimi-code'}) schema rejects missing session_id

- **WHEN** a caller invokes `register_agent({agent_type:'kimi-code', name:'kimi-1', base_url:'http://127.0.0.1:58627'})` with no `session_id`
- **THEN** the response is a Zod validation error citing the missing `session_id`
- **AND** no agents row is written

#### Scenario: register_agent({agent_type:'kimi-code'}) schema rejects missing base_url

- **WHEN** a caller invokes `register_agent({agent_type:'kimi-code', name:'kimi-1', session_id:'session_abc'})` with no `base_url`
- **THEN** the response is a Zod validation error citing the missing `base_url`
- **AND** no agents row is written

#### Scenario: register_agent({agent_type:'kimi-code'}) schema rejects ws:// base_url

- **WHEN** a caller invokes `register_agent({agent_type:'kimi-code', name:'kimi-1', base_url:'ws://127.0.0.1:58627', session_id:'session_abc'})`
- **THEN** the response is a Zod validation error citing the malformed `base_url`

#### Scenario: register_agent({agent_type:'kimi-code'}) preserves auth_token_ref in delivery

- **GIVEN** a caller invokes `register_agent({agent_type:'kimi-code', name:'kimi-1', base_url:'http://127.0.0.1:58627', session_id:'session_abc', auth_token_ref:'KIMI_SERVER_TOKEN'})`
- **WHEN** the agents row is written
- **THEN** `delivery_payload` JSON-decodes to an object containing `auth_token_ref: 'KIMI_SERVER_TOKEN'`

#### Scenario: register_agent({agent_type:'kimi-code'}) without model persists NULL

- **WHEN** a caller invokes `register_agent({agent_type:'kimi-code', name:'kimi-1', base_url:'http://127.0.0.1:58627', session_id:'session_abc'})` with no `model`
- **AND** the call succeeds
- **THEN** the agents row has `model IS NULL`
