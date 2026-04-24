## MODIFIED Requirements

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

## ADDED Requirements

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
