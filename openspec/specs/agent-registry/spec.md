# agent-registry Specification

## Purpose

Persist agent identity tied to MCP session ids, scope visibility by team, and track liveness for all MCP tool callers.
## Requirements
### Requirement: Agents table schema

The database SHALL contain an `agents` table with columns: `agent_id TEXT PRIMARY KEY`, `team TEXT NOT NULL`, `role TEXT NOT NULL`, `name TEXT NOT NULL`, `model TEXT`, `registered_at TEXT NOT NULL`, `last_seen_at TEXT NOT NULL`, `last_processed_event_id INTEGER NOT NULL DEFAULT 0`, `tmux_pane_id TEXT`.

The `name` column is the human-readable identifier used as part of the 3-tuple identity key `(team, name, role)` — it MUST NOT be NULL and MUST NOT be empty after trimming. The `tmux_pane_id` column remains nullable and stores an optional tmux pane identifier (e.g. `%42`).

An index `agents_identity_idx` SHALL exist on `(team, name, role)` to support O(log n) identity lookup during `register_agent`.

#### Scenario: Fresh database creates agents table with nine columns and name is NOT NULL

- **WHEN** daemon bootstraps a fresh database
- **THEN** `PRAGMA table_info('agents')` lists nine columns
- **AND** the `name` column exists with type `TEXT` and `notnull = 1`
- **AND** the `tmux_pane_id` column exists with type `TEXT` and `notnull = 0`
- **AND** `PRAGMA index_list('agents')` contains an index whose definition covers `(team, name, role)` in that order

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

### Requirement: register_agent response hints when tmux_pane_id missing

The daemon MUST attach a `hint: string` field to the successful `register_agent` response if and only if the caller did NOT provide a usable `tmux_pane_id`.  "Not usable" means the field is (a) omitted, (b) an empty string, or (c) a string consisting only of whitespace.  A trimmed non-empty value suppresses the hint.  Error envelopes MUST NEVER carry a hint.

The hint text MUST advise the caller to run a shell command (`tmux display-message -p '#{pane_id}'`) to discover its pane id, then re-register with the result.  The text SHOULD mention cross-agent poke delivery as the motivation.

#### Scenario: Omitted tmux_pane_id triggers hint

- **GIVEN** a caller that invokes `register_agent({ model, role })` with no `tmux_pane_id` key at all
- **WHEN** the call is processed and succeeds
- **THEN** the response contains `hint: <string>`
- **AND** the hint string contains the substring `tmux_pane_id`
- **AND** the hint string contains the substring `tmux display-message`

#### Scenario: Empty string tmux_pane_id triggers hint

- **GIVEN** a caller that invokes `register_agent({ model, role, tmux_pane_id: '' })`
- **WHEN** the call is processed and succeeds
- **THEN** the response contains `hint: <string>` with the same form as the omitted case

#### Scenario: Whitespace-only tmux_pane_id triggers hint

- **GIVEN** a caller that invokes `register_agent({ model, role, tmux_pane_id: '   ' })`
- **WHEN** the call is processed and succeeds
- **THEN** the response contains `hint: <string>` with the same form as the omitted case

#### Scenario: Error envelope never includes hint

- **GIVEN** a register_agent call that fails (e.g. caller unregistered or `agent_id_collision` or any non-success path)
- **WHEN** the daemon returns the error envelope
- **THEN** the response object MUST NOT have a `hint` field

### Requirement: register_agent reuses agent_id by (team, name, role) identity

The `register_agent` MCP tool SHALL take `{ model: string, name: string, role?: string = 'default', team?: string = 'default', tmux_pane_id?: string }` and:

1. Trim `name` and reject with a validation error if empty.
2. SELECT `agent_id FROM agents WHERE team=? AND name=? AND role=?`.
3. If the SELECT returns a row, **reuse** that `agent_id` — UPSERT the row updating `model`, `last_seen_at`, and (if non-blank) `tmux_pane_id`. Return `{ agent_id, team }`.
4. If the SELECT returns no row, generate a fresh `agent_id = randomUUID()` and INSERT the new row. Return `{ agent_id, team }`.

The returned `agent_id` MUST be considered the stable identity for this `(team, name, role)` triple across reconnects. The MCP session id is an orthogonal transport-level artifact and MUST NOT be conflated with `agent_id`.

When `tmux_pane_id` is provided (a non-empty, non-whitespace string), its value MUST be persisted. If omitted or blank, the column value in the reuse case MUST remain the previously-persisted value (i.e. omission means "no change"); in the create-new case it MUST be NULL.

The hint-on-missing-pane-id semantics (see Requirement "register_agent response hints when tmux_pane_id missing") apply unchanged.

#### Scenario: New identity creates a fresh agent_id

- **GIVEN** the agents table has no row for `(default, alice, backend)`
- **WHEN** a new MCP session calls `register_agent({ model: 'opus-4-7', role: 'backend', name: 'alice' })`
- **THEN** response is `{ agent_id: <uuid>, team: 'default' }`
- **AND** the agents row has `name='alice'`, `role='backend'`, `team='default'`
- **AND** `agent_id` is NOT equal to the MCP session id

#### Scenario: Reconnect reuses existing agent_id

- **GIVEN** agent with `(team='default', name='alice', role='backend')` already exists with `agent_id='X'`
- **WHEN** a different MCP session (new session id) calls `register_agent({ model: 'opus-4-7', role: 'backend', name: 'alice' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }` (same X as before)
- **AND** the agents table still has exactly one row for this identity
- **AND** that row's `last_seen_at` is updated to the current timestamp

#### Scenario: Reuse updates tmux_pane_id when provided

- **GIVEN** agent `(default, alice, backend)` exists with `agent_id='X'` and `tmux_pane_id='%42'`
- **WHEN** a new session calls `register_agent({ model, role: 'backend', name: 'alice', tmux_pane_id: '%99' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }`
- **AND** the row's `tmux_pane_id` is now `'%99'`

#### Scenario: Reuse preserves tmux_pane_id when omitted

- **GIVEN** agent `(default, alice, backend)` exists with `tmux_pane_id='%42'`
- **WHEN** a new session calls `register_agent({ model, role: 'backend', name: 'alice' })` (omitting `tmux_pane_id`)
- **THEN** the row's `tmux_pane_id` remains `'%42'` (omission = no change)

#### Scenario: Role change produces new agent_id (new identity)

- **GIVEN** agent `(default, alice, backend)` exists with `agent_id='X'`
- **WHEN** a new session calls `register_agent({ model, role: 'frontend', name: 'alice' })`
- **THEN** response `agent_id` is a fresh UUID (NOT `'X'`)
- **AND** the agents table now contains two rows: one for `(default, alice, backend)` and one for `(default, alice, frontend)`

#### Scenario: Team change produces new agent_id

- **GIVEN** agent `(default, alice, backend)` exists with `agent_id='X'`
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

Any subsequent `register_agent` call for a `(team, name, role)` triple that already has a row in the agents table SHALL upsert metadata on that existing row without producing a new `agent_id`, regardless of whether the call originates from the same MCP session or a new one.

#### Scenario: Same session re-registers with new tmux_pane_id

- **GIVEN** session `sess-A` has registered `(default, alice, backend)` with `tmux_pane_id='%42'` and received `agent_id='X'`
- **WHEN** the same session calls `register_agent({ model, role: 'backend', name: 'alice', tmux_pane_id: '%99' })`
- **THEN** response is `{ agent_id: 'X', team: 'default' }`
- **AND** the row's `tmux_pane_id` becomes `'%99'`

#### Scenario: Re-register after reconnect preserves mailbox continuity

- **GIVEN** agent with `agent_id='X'` has unread messages addressed to X in the mailbox
- **WHEN** the owner reconnects (new MCP session) and calls `register_agent({ model, role, name })` for the same identity
- **THEN** the returned `agent_id` is `'X'`
- **AND** a subsequent `get_inbox()` call returns those unread messages

### Requirement: Within-session agent_id_collision via Authorization header

When a `register_agent` tool call carries an `Authorization` request header, the daemon MUST bind that session id to the sha256 hash of the (trimmed) header value on first binding, and MUST return `{ error: 'agent_id_collision' }` with HTTP status 409 on any subsequent `register_agent` for the **same MCP session id** presenting a different `Authorization` value.

This protection is scoped to within-session: cross-session `register_agent` calls targeting the same `(team, name, role)` identity are legitimate reuse (see the identity-reuse requirement) and MUST NOT trigger 409, regardless of Authorization header values.

When the request carries no `Authorization` header (or an empty one after trim), the daemon MUST NOT enforce collision detection.

Arriving on a different TCP socket (e.g. after keep-alive expiry) MUST NOT by itself trigger a collision.

#### Scenario: Different Authorization credentials on same session id

- **GIVEN** session `sess-A` was first bound to the sha256 of `Authorization: Bearer tokenX`
- **WHEN** a request with `Mcp-Session-Id: sess-A` AND `Authorization: Bearer tokenY` calls `register_agent`
- **THEN** response is HTTP 409 with body `{ error: 'agent_id_collision' }`

#### Scenario: Cross-session same identity under different Authorization reuses agent_id

- **GIVEN** session `sess-A` registered `(default, alice, backend)` with `Authorization: Bearer tokenX`, producing `agent_id='X'`
- **WHEN** a **different** session `sess-B` calls `register_agent` for the same `(default, alice, backend)` identity with `Authorization: Bearer tokenY`
- **THEN** response is success with `agent_id='X'` (reuse, NOT 409)

#### Scenario: Request without Authorization header never triggers collision

- **GIVEN** session `sess-A` was registered previously
- **WHEN** any subsequent `register_agent` arrives for `Mcp-Session-Id: sess-A` carrying no `Authorization` header
- **THEN** response is success (not HTTP 409)

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

