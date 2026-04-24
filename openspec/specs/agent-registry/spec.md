# agent-registry Specification

## Purpose

Persist agent identity tied to MCP session ids, scope visibility by team, and track liveness for all MCP tool callers.
## Requirements
### Requirement: Agents table schema

The database SHALL contain an `agents` table with columns: `agent_id TEXT PRIMARY KEY`, `client TEXT`, `client_name TEXT`, `team TEXT NOT NULL`, `role TEXT NOT NULL`, `name TEXT NOT NULL`, `model TEXT`, `registered_at TEXT NOT NULL`, `last_seen_at TEXT NOT NULL`, `last_processed_event_id INTEGER NOT NULL DEFAULT 0`, `tmux_pane_id TEXT`.

The `name` column is the human-readable identifier used as part of the 2-tuple identity key `(team, name)` — it MUST NOT be NULL and MUST NOT be empty after trimming. The `role` column remains a non-null informational field that describes the agent's function (e.g. `backend`, `frontend`) but is NOT part of the identity key; multiple successive registrations for the same `(team, name)` MAY carry different `role` values and MUST collapse to a single row. The `client` column stores the explicitly declared runtime kind (`codex`, `claude-code`, `opencode`, or `custom`) and MAY be NULL only for legacy rows written before this requirement. The `client_name` column is nullable and stores an optional free-form runtime label used only when `client='custom'`. The `tmux_pane_id` column remains nullable and stores an optional tmux pane identifier (e.g. `%42`).

A UNIQUE index `agents_identity_idx` SHALL exist on `(team, name)` to support O(log n) identity lookup AND to physically prevent multiple rows with the same `(team, name)`.

#### Scenario: Fresh database creates UNIQUE identity index on (team, name)

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA index_list('agents')` contains `agents_identity_idx`
- **AND** `PRAGMA index_info('agents_identity_idx')` lists exactly two columns in order: `team`, `name`
- **AND** `PRAGMA index_list('agents')` shows `agents_identity_idx` with `unique = 1`

#### Scenario: agents table columns match schema

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA table_info('agents')` lists columns: `agent_id`, `client`, `client_name`, `team`, `role`, `name`, `model`, `registered_at`, `last_seen_at`, `last_processed_event_id`, `tmux_pane_id`
- **AND** the `tmux_pane_id` column exists with type `TEXT` and `notnull = 0`
- **AND** the `name` column has `notnull = 1`
- **AND** the `role` column has `notnull = 1`

#### Scenario: Inserting two rows with same (team, name) violates UNIQUE constraint

- **GIVEN** a fresh `agents` table with one row `(team='default', name='alice', role='backend', agent_id='X')`
- **WHEN** a second INSERT is attempted with `(team='default', name='alice', role='frontend', agent_id='Y')`
- **THEN** SQLite raises `UNIQUE constraint failed: agents.team, agents.name`
- **AND** only the original row `agent_id='X'` remains in the table

### Requirement: list_agents scoped to caller team

The `list_agents` MCP tool SHALL take `{ team?: string }` (defaults to caller's team) and return `{ agents: Array<{ agent_id, client?, client_name?, role, name, model?, tmux_pane_id?, last_seen_at, online: boolean }> }`. `online` MUST be true when `last_seen_at` is within the last 5 minutes. Agents from other teams MUST NOT appear. The `name` field is always present and non-empty. The `tmux_pane_id` field MUST be present in every agent entry; its value is the persisted pane id (string) or `null` if unset. `client_name` SHALL be `null` unless `client='custom'`.

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

The daemon MAY end a successful registration with a persisted tmux pane identifier to enable cross-session interrupt delivery.  The MCP tool surface MUST NOT require callers to supply `tmux_pane_id`.  For recognized local clients, the daemon MAY best-effort attempt runtime binding immediately after the identity row is created; otherwise the pane can still be persisted later via explicit runtime-binding tools.  The daemon treats the stored value as an opaque string — it does not parse or validate tmux pane id format, leaving the interpretation to downstream consumers.

#### Scenario: New registration with no resolved pane persists NULL

- **GIVEN** a `register_agent` call that does not resolve any usable pane
- **WHEN** the daemon processes the registration
- **THEN** the agents row's `tmux_pane_id` column stores NULL
- **AND** the call returns success
- **AND** `list_agents` entry for this agent has `tmux_pane_id === null`

#### Scenario: Non-tmux environment unaffected by internal detection

- **GIVEN** a register_agent call from an IDE plugin or desktop app with no tmux environment
- **WHEN** the call is processed
- **THEN** the daemon does not error
- **AND** it persists the row with `tmux_pane_id IS NULL`

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

- **GIVEN** a caller that invokes `register_agent({ client: 'custom', model, role })`
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

- **WHEN** a caller invokes `register_agent({ client: 'custom', model, name, role, tmux_pane_id: '%42' })`
- **THEN** the call is rejected at the schema layer as an unrecognized top-level key
- **AND** no row is created or updated

#### Scenario: Non-tmux delivery suppresses hint

- **GIVEN** a caller that invokes `register_agent({ client: 'codex', model, role, delivery: { kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799' } })`
- **WHEN** the call is processed and succeeds
- **THEN** the response object MUST NOT have a `hint` field

#### Scenario: Error envelope never includes hint

- **GIVEN** a register_agent call that fails (e.g. caller unregistered or `agent_id_collision` or any non-success path)
- **WHEN** the daemon returns the error envelope
- **THEN** the response object MUST NOT have a `hint` field

### Requirement: register_agent reuses agent_id by (team, name, role) identity

The `register_agent` MCP tool SHALL take `{ client: 'codex' | 'claude-code' | 'opencode' | 'custom', client_name?: string, model: string, name: string, role?: string = 'default', team?: string, project_dir?: string, ui_pid?: number, delivery?: DeliverySpec }` and:

1. Trim `name` and reject with a validation error if empty.
2. Require `client` explicitly.  `client_name` MAY be supplied only when `client='custom'`.
3. Derive the effective `team` value by applying this three-level precedence:
   - If `team` is provided and non-empty after trimming, use it as-is.
   - Else if `project_dir` is provided, compute `basename(project_dir)`, trim it, lowercase it (POSIX `basename` semantics — trailing slashes stripped before taking the last component), and if the result is non-empty use it as the effective team.
   - Else fall back to the literal string `'default'`.
   The derived value is then used wherever the original `team` parameter was consumed (UPSERT key, response, runtime binding).
4. Execute an atomic UPSERT keyed on `(team, name)` where `team` is the derived value:
   - If no row exists for `(team, name)`: INSERT a new row with a freshly generated `agent_id = randomUUID()`, the provided `role`, `model`, `registered_at = now`, `last_seen_at = now`, and `tmux_pane_id = NULL` unless an earlier runtime binding already existed for that identity.
   - If a row already exists for `(team, name)`: UPDATE that row's `client`, `client_name`, `role`, `model`, `last_seen_at`; preserve `agent_id`, `registered_at`, and `last_processed_event_id`; preserve the existing `tmux_pane_id` until a later automatic or explicit runtime-binding attempt writes a new usable value.
5. After the identity row exists, best-effort attempt automatic runtime binding for this session:
   - The daemon MUST NOT accept caller-supplied pane ids or pane-detect hints through the MCP tool surface.
   - If `ui_pid` is provided, the daemon MUST prefer the verified `ui_pid -> tty -> pane` runtime-binding path.
   - For `client='codex' | 'claude-code' | 'opencode'`, the daemon MUST use that explicit client kind as the built-in matcher for automatic tmux detection.
   - For `client='custom'`, the daemon MUST skip built-in matcher inference and treat automatic runtime binding as not attempted unless a later dedicated binding tool is invoked.
   - If `ui_pid` is absent and a built-in matcher is available, the daemon MUST invoke the same pane detector behind `detect_tmux_pane` for that matcher, and if detection succeeds, it MUST run the same verified persistence path as `bind_runtime_identity(...)` using the detected pane's tty plus pane id.
   - If no matcher is available, or the detector/runtime binder returns `ambiguous_match`, `not_found`, `tmux_unavailable`, or any other non-success result, the daemon MUST treat this attempt as having no new pane id rather than failing the registration.
6. Return `{ agent_id, team }` where `agent_id` is either the preserved or newly generated id and `team` is the derived value from step 3.

The returned `agent_id` MUST be considered the stable identity for this `(team, name)` pair across reconnects AND across role changes. Changing the `role` parameter on a subsequent register does NOT produce a new `agent_id`; it updates the existing row's `role` column in place. The MCP session id is an orthogonal transport-level artifact and MUST NOT be conflated with `agent_id`.

When an automatic or explicit runtime-binding attempt resolves a usable `tmux_pane_id`, its value MUST be persisted. If the current registration attempt resolves no new pane id, the column value in the reuse case MUST remain the previously-persisted value; in the create-new case it MUST be NULL.

The hint-on-missing-pane-id semantics (see Requirement "register_agent response hints when tmux_pane_id missing") apply unchanged.

`project_dir` MUST be treated as an input-only hint for default team derivation; it MUST NOT be persisted on the agents row and MUST NOT be returned in the response.

#### Scenario: Automatic runtime binding persists a detected pane during register_agent

- **GIVEN** the caller invokes `register_agent({ client: 'codex', model, name: 'alice' })`
- **AND** the detector converges on a single pane `%1902`
- **AND** verified runtime binding succeeds for `%1902`
- **WHEN** the call is processed and succeeds
- **THEN** the stored `tmux_pane_id` is `'%1902'`
- **AND** the response object MUST NOT have a `hint` field

#### Scenario: ui_pid drives automatic runtime binding during register_agent

- **GIVEN** the caller invokes `register_agent({ client: 'codex', model, name: 'alice', ui_pid: 25079 })`
- **AND** verified runtime binding via `ui_pid=25079` succeeds and resolves pane `%1902`
- **WHEN** the call is processed and succeeds
- **THEN** the stored `tmux_pane_id` is `'%1902'`
- **AND** the stored `runtime_ui_pid` is `25079`
- **AND** the response object MUST NOT have a `hint` field

#### Scenario: New identity creates a fresh agent_id

- **GIVEN** the agents table has no row for `(team='default', name='alice')`
- **WHEN** a new MCP session calls `register_agent({ client: 'custom', model: 'opus-4-7', role: 'backend', name: 'alice' })`
- **THEN** response is `{ agent_id: <uuid>, team: 'default' }`
- **AND** the agents row has `name='alice'`, `role='backend'`, `team='default'`
- **AND** `agent_id` is NOT equal to the MCP session id

#### Scenario: Reconnect reuses existing agent_id

- **GIVEN** agent with `(team='default', name='alice')` already exists with `agent_id='X'` and `role='backend'`
- **WHEN** a different MCP session (new session id) calls `register_agent({ client: 'custom', model: 'opus-4-7', role: 'backend', name: 'alice' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }` (same X as before)
- **AND** the agents table still has exactly one row for this identity
- **AND** that row's `last_seen_at` is updated to the current timestamp
- **AND** that row's `registered_at` is unchanged from the original registration

#### Scenario: Role change updates existing agent_id in-place

- **GIVEN** agent `(team='default', name='alice')` exists with `agent_id='X'` and `role='backend'`
- **WHEN** a subsequent session calls `register_agent({ client: 'custom', model, role: 'frontend', name: 'alice' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }` (same X — NOT a new UUID)
- **AND** the agents table still has exactly one row for `(team='default', name='alice')`
- **AND** that row's `role` is now `'frontend'`
- **AND** that row's `last_processed_event_id` (mailbox cursor) is preserved across the role change

#### Scenario: custom client may persist client_name

- **GIVEN** a caller invokes `register_agent({ client: 'custom', client_name: 'kimi-coder', model, name: 'alice' })`
- **WHEN** the call is processed and succeeds
- **THEN** the agents row stores `client='custom'`
- **AND** the agents row stores `client_name='kimi-coder'`

#### Scenario: client_name is rejected for non-custom clients

- **WHEN** a caller invokes `register_agent({ client: 'codex', client_name: 'codex-cli', model, name: 'alice' })`
- **THEN** the call is rejected at the schema layer

#### Scenario: missing client is rejected

- **WHEN** a caller invokes `register_agent({ model, name: 'alice' })`
- **THEN** the call is rejected at the schema layer

#### Scenario: Reuse updates tmux_pane_id when a later registration finds a new unique pane

- **GIVEN** agent `(default, alice)` exists with `agent_id='X'`, `role='backend'`, and `tmux_pane_id='%42'`
- **AND** a later registration attempt auto-detects `%99` as the unique pane for the same identity
- **WHEN** a new session calls `register_agent({ client: 'custom', model, role: 'backend', name: 'alice' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }`
- **AND** the row's `tmux_pane_id` is now `'%99'`

#### Scenario: Reuse preserves tmux_pane_id when omitted

- **GIVEN** agent `(default, alice)` exists with `tmux_pane_id='%42'`
- **WHEN** a new session calls `register_agent({ client: 'custom', model, role: 'backend', name: 'alice' })`
- **AND** that registration attempt does not resolve any new pane
- **THEN** the row's `tmux_pane_id` remains `'%42'`

#### Scenario: Team change produces new agent_id

- **GIVEN** agent `(team='default', name='alice')` exists with `agent_id='X'`
- **WHEN** a new session calls `register_agent({ client: 'custom', model, role: 'backend', name: 'alice', team: 'alpha' })`
- **THEN** response `agent_id` is a fresh UUID (NOT `'X'`)
- **AND** two rows exist: one in team `default`, one in team `alpha`

#### Scenario: Name is required and must be non-empty

- **WHEN** a caller invokes `register_agent({ client: 'custom', model, role: 'backend' })` (no `name` field)
- **THEN** the call is rejected at the schema layer (MCP returns a validation error; no row is created)

#### Scenario: Name after trim must be non-empty

- **WHEN** a caller invokes `register_agent({ client: 'custom', model, role: 'backend', name: '   ' })` (whitespace only)
- **THEN** the call is rejected with a validation error; no row is created

#### Scenario: Role defaults to "default" when omitted

- **WHEN** a caller invokes `register_agent({ client: 'custom', model: 'opus-4-7', name: 'alice' })` (no `role` field)
- **THEN** the call succeeds and the agents row has `role='default'`

#### Scenario: Team defaults to "default" when both team and project_dir are omitted

- **WHEN** a caller invokes `register_agent({ client: 'custom', model, name: 'alice', role: 'backend' })` (no `team` and no `project_dir`)
- **THEN** the call succeeds and the agents row has `team='default'`
- **AND** the response is `{ agent_id: <uuid>, team: 'default' }`

#### Scenario: team is derived from basename of project_dir when team is omitted

- **GIVEN** the agents table has no row for `(team='cross-agent-teams-mcp', name='alice')`
- **WHEN** a caller invokes `register_agent({ client: 'custom', model, name: 'alice', role: 'backend', project_dir: '/Users/jt/workspace/cross-agent-teams-mcp' })`
- **THEN** the call succeeds
- **AND** the agents row has `team='cross-agent-teams-mcp'`
- **AND** the response is `{ agent_id: <uuid>, team: 'cross-agent-teams-mcp' }`

#### Scenario: basename normalization strips trailing slashes and lowercases

- **WHEN** a caller invokes `register_agent({ client: 'custom', model, name: 'alice', role: 'backend', project_dir: '/Users/jt/workspace/Cross-Agent-Teams-MCP/' })`
- **THEN** the derived team is `'cross-agent-teams-mcp'` (trailing slash ignored, mixed case normalized to lowercase)

#### Scenario: explicit team overrides project_dir derivation

- **WHEN** a caller invokes `register_agent({ client: 'custom', model, name: 'alice', role: 'backend', team: 'alpha', project_dir: '/Users/jt/workspace/some-repo' })`
- **THEN** the derived team is `'alpha'` (explicit `team` wins over `project_dir`)
- **AND** the agents row has `team='alpha'`

#### Scenario: project_dir is not persisted on the agents row

- **WHEN** a caller invokes `register_agent({ client: 'custom', model, name: 'alice', project_dir: '/Users/jt/workspace/some-repo' })`
- **THEN** the call succeeds
- **AND** the agents row has no column or JSON blob containing the literal string `'/Users/jt/workspace/some-repo'`
- **AND** the `list_agents` response for this agent does NOT expose `project_dir`

#### Scenario: project_dir with empty basename falls back to 'default'

- **WHEN** a caller invokes `register_agent({ client: 'custom', model, name: 'alice', project_dir: '/' })`
- **THEN** `basename('/')` is empty after trimming, so team falls back to `'default'`
- **AND** the agents row has `team='default'`

### Requirement: register_claude_self mirrors register_agent team default derivation

The `register_claude_self` MCP tool SHALL accept an optional `project_dir: string` field and SHALL apply the same three-level team precedence (`team` > `basename(project_dir)` > `'default'`) as `register_agent`, via the same derivation code path (so the two tools share a single source of truth for default team selection).

#### Scenario: register_claude_self derives team from project_dir when team is omitted

- **WHEN** a caller invokes `register_claude_self({ name: 'lead', project_dir: '/Users/jt/workspace/cross-agent-teams-mcp' })` with no explicit `team`
- **THEN** the call succeeds
- **AND** the agents row has `team='cross-agent-teams-mcp'`

#### Scenario: register_claude_self falls back to 'default' when both team and project_dir are omitted

- **WHEN** a caller invokes `register_claude_self({ name: 'lead' })` with neither `team` nor `project_dir`
- **THEN** the call succeeds
- **AND** the agents row has `team='default'`

#### Scenario: explicit team still wins in register_claude_self

- **WHEN** a caller invokes `register_claude_self({ name: 'lead', team: 'alpha', project_dir: '/Users/jt/workspace/some-repo' })`
- **THEN** the agents row has `team='alpha'`

### Requirement: Repeated register_agent for same identity updates metadata

Any subsequent `register_agent` call for a `(team, name)` pair that already has a row in the agents table SHALL upsert metadata on that existing row without producing a new `agent_id`, regardless of whether the call originates from the same MCP session or a new one, and regardless of whether the `role` parameter on the subsequent call matches the persisted `role`.

Upsert fields: `role`, `model`, `last_seen_at` are overwritten by the incoming values; `tmux_pane_id` is overwritten only when the current registration attempt resolves a usable pane id; `agent_id`, `registered_at`, and `last_processed_event_id` are preserved.

#### Scenario: Same session re-registers and replaces tmux_pane_id after a new detector result

- **GIVEN** session `sess-A` has registered `(default, alice)` with `role='backend'`, `tmux_pane_id='%42'` and received `agent_id='X'`
- **AND** a later registration attempt auto-detects `%99` as the unique pane for that same identity
- **WHEN** the same session calls `register_agent({ client: 'custom', model, role: 'backend', name: 'alice' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }`
- **AND** the row's `tmux_pane_id` becomes `'%99'`

#### Scenario: Re-register after reconnect preserves mailbox continuity

- **GIVEN** agent with `agent_id='X'` has unread messages addressed to X in the mailbox, and `last_processed_event_id=5`
- **WHEN** the owner reconnects (new MCP session) and calls `register_agent({ client: 'custom', model, role, name })` for the same `(team, name)` identity — with the same OR a different `role`
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
- **WHEN** session `sess-B` calls `register_agent({ client: 'custom', model, team: 'default', name: 'alice', role: 'frontend' })`
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

- **GIVEN** a fresh MCP session calling `register_agent({client: 'custom', team: 'default', name: 'alice', model: 'sonnet'})` with no `delivery` field
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

The daemon SHALL expose Codex app-server registration through `register_agent({ client: 'codex', ... })`.  For Codex callers, the tool accepts the normal identity fields plus optional `ws_url`, `auth_token_ref`, and `thread_id`.  It SHALL:

1. Connect to the Codex app-server websocket, defaulting `ws_url` to `ws://127.0.0.1:8799` when not provided.
2. Initialize the Codex protocol.
3. If `thread_id` is provided, attempt `thread/resume` only for that thread id.
4. If `thread_id` is omitted, call `thread/loaded/list`, attempt `thread/resume` against the loaded thread ids, and return `{ error: 'thread_id_required', detail: { ws_url, thread_ids: [...] } }` instead of registering any thread.
5. Register the caller as `delivery.kind='codex-appserver'` only after a caller-supplied `thread_id` has been confirmed resumable.
6. Leave tmux pane binding unchanged.  If the caller wants tmux fallback delivery, it MUST rely on the normal runtime-binding path or invoke `bind_runtime_identity(...)` explicitly afterward.

The daemon MUST NOT infer the caller's current Codex thread solely from the set of loaded or resumable threads.  The tool surface MUST reject Codex-only top-level fields unless `client='codex'`.  When no new usable pane id is available, the persisted `tmux_pane_id` follows the normal registration semantics: omit on first insert yields `NULL`, omit on re-registration preserves the existing value.

The Codex registration path is Codex-only.  If the websocket endpoint is unreachable or does not speak the expected Codex protocol, the tool SHALL return `{error: 'unsupported_client', detail: { expected: 'codex', reason: ..., ws_url, cause? }}` rather than guessing.

#### Scenario: register_agent registers a caller-supplied Codex thread_id without changing tmux pane state

- **GIVEN** the caller invokes `register_agent({ client: 'codex', name: 'lead', model: 'gpt-5', team: 'default', role: 'worker', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** `thread/resume` succeeds for `11111111-1111-4111-8111-111111111111`
- **WHEN** the tool completes successfully
- **THEN** it returns `{ agent_id, team: 'default', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799' }`
- **AND** the caller's `agents` row is persisted with `delivery.kind='codex-appserver'`
- **AND** the tool does not require tmux pane discovery to succeed

#### Scenario: register_agent rejects Codex thread inputs without client=codex

- **WHEN** a caller invokes `register_agent({ client: 'custom', name: 'lead', model: 'gpt-5', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **THEN** the MCP tool schema rejects the request as carrying an unknown top-level key
- **AND** the tool does not accept Codex-only fields unless `client='codex'`

#### Scenario: explicit runtime binding can follow Codex register_agent

- **GIVEN** the caller first succeeds with `register_agent({ client: 'codex', name: 'lead', model: 'gpt-5', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** the caller still has no usable persisted `tmux_pane_id`
- **WHEN** the caller later invokes `bind_runtime_identity(...)` successfully
- **THEN** the existing `delivery.kind='codex-appserver'` remains intact
- **AND** the caller row gains the verified `tmux_pane_id` written by the runtime-binding path

#### Scenario: re-registration preserves existing pane when no new pane is found

- **GIVEN** agent `(default, lead)` already exists with `tmux_pane_id='%42'`
- **AND** the caller invokes `register_agent({ client: 'codex', name: 'lead', model: 'gpt-5', team: 'default', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** `thread/resume` succeeds for `11111111-1111-4111-8111-111111111111`
- **AND** Codex tmux pane detection returns `not_found`
- **WHEN** the tool completes successfully
- **THEN** the caller's `agents` row keeps `tmux_pane_id='%42'`
- **AND** the caller's `agents` row is updated with the newly confirmed `delivery.kind='codex-appserver'`

#### Scenario: register_agent requires explicit thread_id when resumable threads exist for Codex

- **GIVEN** the caller invokes `register_agent({ client: 'codex', name: 'lead', model: 'gpt-5' })`
- **AND** the default websocket endpoint reports resumable thread ids `['11111111-1111-4111-8111-111111111111']`
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'thread_id_required', detail: { ws_url: 'ws://127.0.0.1:8799', thread_ids: ['11111111-1111-4111-8111-111111111111'] } }`
- **AND** no `agents` row is inserted or updated for the caller

#### Scenario: register_agent returns no_loaded_threads for Codex

- **GIVEN** the caller invokes `register_agent({ client: 'codex', name: 'lead', model: 'gpt-5' })`
- **AND** the Codex app-server reports zero loaded threads
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'no_loaded_threads', detail: { ws_url: 'ws://127.0.0.1:8799' } }`

#### Scenario: register_agent returns codex_resume_failed for an explicit thread_id

- **GIVEN** the caller invokes `register_agent({ client: 'codex', name: 'lead', model: 'gpt-5', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** the app-server returns a JSON-RPC error for `thread/resume`
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'codex_resume_failed', detail: { thread_id: '11111111-1111-4111-8111-111111111111', cause: ... } }`

#### Scenario: register_agent returns unsupported_client outside Codex

- **GIVEN** the caller invokes `register_agent({ client: 'codex', name: 'lead', model: 'gpt-5', thread_id: '11111111-1111-4111-8111-111111111111' })`
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
- **WHEN** a later MCP session invokes `register_agent({ client: 'custom', model: 'opus-4-7', name: 'alice', team: 'default' })`
- **THEN** the call succeeds
- **AND** the `agents` table contains exactly one row for `(team='default', name='alice')`
