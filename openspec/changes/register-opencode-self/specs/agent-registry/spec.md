## MODIFIED Requirements

### Requirement: Agents table includes opencode transport columns

The `agents` table SHALL include two additional nullable columns:

- `opencode_base_url TEXT`
- `opencode_session_id TEXT`

These columns store the loopback opencode server base URL and the bound session id for server-based poke delivery.  `NULL` means the agent has not bound an opencode transport.

The columns are written by `bind_opencode_session`, by `register_opencode_self` (via launcher pre-reg consumption), and by the opencode branch of `register_agent` (either from explicit `base_url` / `session_id` arguments or from pre-reg consumption).

#### Scenario: Fresh database creates opencode transport columns

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA table_info('agents')` lists a column named `opencode_base_url`
- **AND** `PRAGMA table_info('agents')` lists a column named `opencode_session_id`
- **AND** rows inserted without those fields default to `NULL`

## ADDED Requirements

### Requirement: opencode_pane_pre_registrations table exists on fresh databases

The daemon SHALL create a table `opencode_pane_pre_registrations` with columns `pane_id TEXT PRIMARY KEY`, `base_url TEXT NOT NULL`, `session_id TEXT NOT NULL`, and `expires_at TEXT NOT NULL` when bootstrapping a fresh `data.db`, and MUST add it via migration to existing databases that lack it.

#### Scenario: Fresh database creates the opencode pre-reg table

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA table_info('opencode_pane_pre_registrations')` lists columns named `pane_id`, `base_url`, `session_id`, `expires_at`
- **AND** `pane_id` is the primary key

#### Scenario: Existing database gains the table via migration

- **GIVEN** an existing `data.db` whose schema predates this change and lacks the table
- **WHEN** a new daemon version boots
- **THEN** the table is created
- **AND** no existing rows in other tables are modified

### Requirement: pre_register_opencode_pane tool records pending tmux pane claim

The daemon SHALL expose an MCP tool `pre_register_opencode_pane` that accepts `pane_id` (string, tmux pane identifier such as `%1972`), `base_url` (non-empty string, absolute URL whose host MUST resolve to loopback form `127.0.0.1`, `localhost`, or `::1`), `session_id` (non-empty trimmed string), and optional `ttl_seconds` (positive integer, default `120`, capped at `600`).  On success it SHALL persist a pending pre-registration row keyed by `pane_id` into `opencode_pane_pre_registrations` and return `{ ok: true, expires_at: <ISO8601> }`.  If any required argument is missing, empty, or invalid, the tool SHALL return `{ error: <code>, detail: <message> }` without writing any state.

#### Scenario: launcher records pending opencode pane pre-reg

- **WHEN** the launcher calls `pre_register_opencode_pane({pane_id:"%1972", base_url:"http://127.0.0.1:4096", session_id:"ses_25123ad2affeZxxMmrPHR8YLPs"})`
- **THEN** the response is `{ ok: true, expires_at: <ISO8601 ~120 seconds in the future> }`
- **AND** `opencode_pane_pre_registrations` has one row with those four values

#### Scenario: missing pane_id is rejected

- **WHEN** the launcher calls `pre_register_opencode_pane({base_url:"http://127.0.0.1:4096", session_id:"ses_abc"})` without `pane_id`
- **THEN** the response is `{ error: "invalid_arguments", detail: <message> }`
- **AND** `opencode_pane_pre_registrations` has no new rows

#### Scenario: blank session_id is rejected

- **WHEN** the launcher calls `pre_register_opencode_pane({pane_id:"%10", base_url:"http://127.0.0.1:4096", session_id:"   "})`
- **THEN** the response is `{ error: "invalid_opencode_session_id", detail: <message> }`
- **AND** `opencode_pane_pre_registrations` has no new rows

#### Scenario: non-loopback base_url is rejected

- **WHEN** the launcher calls `pre_register_opencode_pane({pane_id:"%10", base_url:"http://10.0.0.5:4096", session_id:"ses_abc"})`
- **THEN** the response is `{ error: "invalid_opencode_base_url", detail: <message> }`
- **AND** `opencode_pane_pre_registrations` has no new rows

#### Scenario: ttl_seconds cap applies

- **WHEN** the launcher calls `pre_register_opencode_pane({pane_id:"%10", base_url:"http://127.0.0.1:4096", session_id:"ses_abc", ttl_seconds:9999})`
- **THEN** the response is `{ ok: true, expires_at: <ISO8601 ~600 seconds in the future> }`
- **AND** the persisted `expires_at` is at most 600 seconds after the call time

### Requirement: pre_register_opencode_pane overwrites existing entry for same pane

A second `pre_register_opencode_pane` call for the same `pane_id` SHALL replace the previous row (same primary key), updating `base_url`, `session_id`, and `expires_at`.

#### Scenario: second call for same pane replaces the row

- **GIVEN** `opencode_pane_pre_registrations` has a row with `pane_id="%1972"`, `session_id="A"`, `expires_at=T1`
- **WHEN** the launcher calls `pre_register_opencode_pane({pane_id:"%1972", base_url:"http://127.0.0.1:4096", session_id:"B"})`
- **THEN** the response is `{ ok: true, expires_at: <new T2 > T1> }`
- **AND** `opencode_pane_pre_registrations` has exactly one row for `pane_id="%1972"` with `session_id="B"` and `expires_at=T2`

### Requirement: Expired opencode pre-reg rows are ignored and cleaned up

A row in `opencode_pane_pre_registrations` whose `expires_at` is in the past SHALL NOT match any `register_opencode_self` or `register_agent({client:'opencode'})` call, even if `pane_id` aligns.  The daemon SHALL remove expired rows opportunistically (at minimum: on every `pre_register_opencode_pane` write and on every opencode-side register consumption attempt).

#### Scenario: expired row does not auto-bind

- **GIVEN** `opencode_pane_pre_registrations` has a row with `pane_id="%1972"` and `expires_at` in the past
- **AND** a caller whose runtime pane resolves to `%1972`
- **WHEN** that caller invokes `register_opencode_self({name:"glm"})`
- **THEN** the response contains `agent_id` and no error
- **AND** the caller's agent row has `opencode_base_url=NULL`, `opencode_session_id=NULL`
- **AND** the expired row is removed from `opencode_pane_pre_registrations`

#### Scenario: writing a new pre-reg cleans up expired rows

- **GIVEN** `opencode_pane_pre_registrations` has expired rows for `pane_id="%1000"` and `pane_id="%2000"`
- **WHEN** any client calls `pre_register_opencode_pane({pane_id:"%3000", base_url:"http://127.0.0.1:4096", session_id:"ses_abc"})`
- **THEN** the response is `{ ok: true, expires_at: <T> }`
- **AND** rows for `%1000` and `%2000` are removed from the table

### Requirement: register_opencode_self consumes pre-reg and binds opencode metadata

When `register_opencode_self` is invoked AND the daemon resolves the caller's tmux pane (via the existing `pid → tty → pane` helper) AND a live (non-expired) row exists in `opencode_pane_pre_registrations` for that pane, the daemon SHALL, after completing the identity UPSERT:

1. Populate the caller's `agents.opencode_base_url` and `agents.opencode_session_id` from the pre-reg row.
2. Set `client='opencode'` on the caller row (mirroring `bind_opencode_session`).
3. Delete the consumed pre-reg row in the same transaction as the agent-row update.

The auto-bind runs before the response is returned.  If the caller's pane cannot be resolved OR no matching live row exists, the call MUST still succeed; the opencode metadata columns stay NULL (best-effort, mirroring the codex pattern).

#### Scenario: register_opencode_self auto-binds when pre-reg exists for same pane

- **GIVEN** `opencode_pane_pre_registrations` has row `{pane_id:"%2018", base_url:"http://127.0.0.1:4096", session_id:"ses_abc", expires_at:<future>}`
- **AND** the caller's runtime pane resolves to `%2018`
- **WHEN** the caller invokes `register_opencode_self({name:"glm", project_dir:"/Users/jt/workspace/cross-agent-teams-mcp"})`
- **THEN** the response contains `agent_id`
- **AND** the caller's agent row has `opencode_base_url='http://127.0.0.1:4096'`
- **AND** the caller's agent row has `opencode_session_id='ses_abc'`
- **AND** the caller's agent row has `client='opencode'`
- **AND** the pre-reg row for `%2018` is removed

#### Scenario: register_opencode_self with no matching pre-reg leaves fields NULL

- **GIVEN** `opencode_pane_pre_registrations` is empty OR has no row for the caller's pane
- **WHEN** the caller invokes `register_opencode_self({name:"glm"})`
- **THEN** the response contains `agent_id`
- **AND** the caller's agent row has `opencode_base_url=NULL`, `opencode_session_id=NULL`
- **AND** the call does not return any error

#### Scenario: register_opencode_self when pane cannot be resolved leaves fields NULL

- **GIVEN** the daemon cannot resolve the caller's tmux pane (no TTY or no pane match)
- **WHEN** the caller invokes `register_opencode_self({name:"glm"})`
- **THEN** the response contains `agent_id`
- **AND** the caller's agent row has `opencode_base_url=NULL`, `opencode_session_id=NULL`
- **AND** no row in `opencode_pane_pre_registrations` is modified

#### Scenario: consumed pre-reg is single-use

- **GIVEN** a successful auto-bind has just consumed pre-reg row `%2018`
- **WHEN** the same MCP session re-invokes `register_opencode_self({name:"glm"})` without a new `pre_register_opencode_pane` call
- **THEN** the caller's agent row's `opencode_base_url` and `opencode_session_id` are set to NULL (reverting to the pre-bind state for this fresh call, since the row cannot be re-consumed)

### Requirement: register_opencode_self strict schema rejects unknown keys

The `register_opencode_self` tool SHALL accept only `name` (required, non-empty string), and optional `team`, `role`, `project_dir`, `model`.  Strict zod parsing MUST reject any other key (in particular `ui_pid`, `channel_session_id`, `delivery`, `base_url`, `session_id`, `thread_id`, `claude_ui_pid`) with a schema validation error.  When `model` is omitted the tool SHALL default to an opencode-specific value (e.g., `'opencode'`).

#### Scenario: missing name is rejected

- **WHEN** the caller invokes `register_opencode_self({})`
- **THEN** the response is a schema validation error
- **AND** no agent row is created

#### Scenario: explicit ui_pid is rejected

- **WHEN** the caller invokes `register_opencode_self({name:"glm", ui_pid:42305})`
- **THEN** the response is a schema validation error
- **AND** no agent row is created

#### Scenario: explicit base_url is rejected

- **WHEN** the caller invokes `register_opencode_self({name:"glm", base_url:"http://127.0.0.1:4096"})`
- **THEN** the response is a schema validation error
- **AND** no agent row is created

#### Scenario: model defaults when omitted

- **GIVEN** `opencode_pane_pre_registrations` has no live row for the caller's pane
- **WHEN** the caller invokes `register_opencode_self({name:"glm"})`
- **THEN** the caller's agent row has `model='opencode'` (or the documented opencode-specific default)

### Requirement: register_opencode_self mirrors register_agent team default derivation

The `register_opencode_self` tool SHALL accept an optional `project_dir` field and SHALL apply the same three-level team precedence (`team` > `basename(project_dir)` > `'default'`) as `register_agent`, via the same derivation code path (so the three self-register tools share a single source of truth for default team selection).

#### Scenario: team derives from project_dir when omitted

- **WHEN** the caller invokes `register_opencode_self({name:"glm", project_dir:"/Users/jt/workspace/cross-agent-teams-mcp"})` with no explicit `team`
- **THEN** the caller's agent row has `team='cross-agent-teams-mcp'`

#### Scenario: team falls back to 'default' when both team and project_dir are omitted

- **WHEN** the caller invokes `register_opencode_self({name:"glm"})` with neither `team` nor `project_dir`
- **THEN** the caller's agent row has `team='default'`

#### Scenario: explicit team still wins

- **WHEN** the caller invokes `register_opencode_self({name:"glm", team:"alpha", project_dir:"/Users/jt/workspace/some-repo"})`
- **THEN** the caller's agent row has `team='alpha'`

### Requirement: register_agent client=opencode consumes pre-reg when opencode metadata is omitted

The auto-bind path described in the "register_opencode_self consumes pre-reg and binds opencode metadata" requirement SHALL additionally apply to `register_agent({client:'opencode', ...})` calls that do NOT supply both `base_url` and `session_id`.  If the caller supplies `base_url` and `session_id` explicitly, those values take precedence over any pre-reg row and the existing `bind_opencode_session` call inside `executeRegister` MUST continue to run; in that case the pre-reg lookup MUST be skipped entirely.  Callers with other client kinds (`codex`, `claude-code`, `custom`) are NOT affected by this auto-bind.

#### Scenario: register_agent opencode without metadata auto-binds from pre-reg

- **GIVEN** `opencode_pane_pre_registrations` has row `{pane_id:"%2018", base_url:"http://127.0.0.1:4096", session_id:"ses_abc", expires_at:<future>}`
- **AND** the caller's runtime pane resolves to `%2018`
- **WHEN** the caller invokes `register_agent({client:"opencode", name:"glm", project_dir:"/Users/jt/workspace/cross-agent-teams-mcp", model:"glm-5.1"})`
- **THEN** the caller's agent row has `opencode_base_url='http://127.0.0.1:4096'`, `opencode_session_id='ses_abc'`, `client='opencode'`
- **AND** the pre-reg row is consumed

#### Scenario: register_agent opencode with explicit metadata wins over pre-reg

- **GIVEN** `opencode_pane_pre_registrations` has row `{pane_id:"%2018", base_url:"http://127.0.0.1:4096", session_id:"ses_from_prereg", expires_at:<future>}`
- **AND** the caller's runtime pane resolves to `%2018`
- **WHEN** the caller invokes `register_agent({client:"opencode", name:"glm", base_url:"http://127.0.0.1:4096", session_id:"ses_explicit"})`
- **THEN** the caller's agent row has `opencode_session_id='ses_explicit'`
- **AND** the pre-reg row remains untouched (no consumption)

### Requirement: register_opencode_self description guides opencode agents toward launcher-driven activation

The `register_opencode_self` tool description SHALL explicitly instruct opencode LLM callers to:

1. Prefer `register_opencode_self` over `register_agent` when they are running inside an opencode CLI launched through the xats opencode launcher.
2. Omit `base_url` / `session_id` — these are auto-populated from the launcher pre-reg (`pre_register_opencode_pane`) and supplying them disables the pre-reg auto-bind path.
3. Rely on the launcher pre-reg (`pre_register_opencode_pane`) for tmux pane binding; do not attempt to discover pane information themselves.

#### Scenario: tool description mentions launcher pre-reg

- **WHEN** an MCP client enumerates `register_opencode_self` via `tools/list`
- **THEN** the returned description is non-empty
- **AND** it contains the literal string `pre_register_opencode_pane` (or an equivalent reference to the pre-reg auto-bind mechanism)

### Requirement: register_agent description points opencode callers at register_opencode_self

The existing `register_agent` tool description SHALL include guidance that opencode clients should prefer `register_opencode_self` and should NOT pass `base_url` / `session_id` when launched through the xats opencode launcher: the launcher pre-reg flow auto-binds the session, and manually supplied opencode metadata overrides the pre-reg auto-bind path.

#### Scenario: register_agent description points opencode callers at register_opencode_self

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the returned description contains a hint along the lines of "opencode clients launched via the xats opencode launcher should use `register_opencode_self` and omit `base_url` / `session_id`"
