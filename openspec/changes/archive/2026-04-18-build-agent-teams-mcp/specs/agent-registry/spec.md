## ADDED Requirements

### Requirement: Agents table schema

The database SHALL contain an `agents` table with columns: `agent_id TEXT PRIMARY KEY`, `team TEXT NOT NULL`, `role TEXT NOT NULL`, `display_name TEXT`, `model TEXT`, `registered_at TEXT NOT NULL`, `last_seen_at TEXT NOT NULL`, `last_processed_event_id INTEGER NOT NULL DEFAULT 0`.

#### Scenario: Fresh database creates agents table

- **WHEN** daemon bootstraps a fresh database
- **THEN** `PRAGMA table_info('agents')` lists the eight columns with correct types

### Requirement: register_agent uses MCP session id as agent_id

The `register_agent` MCP tool SHALL take `{ model: string, role: string, display_name?: string, team?: string = 'default' }` and use the current MCP session's UUID as the `agent_id`. It MUST return `{ agent_id, team }`.

#### Scenario: New session registers successfully

- **GIVEN** an MCP client with a fresh session id `sess-A`
- **WHEN** it calls `register_agent({ model: 'opus-4-6', role: 'backend' })`
- **THEN** response is `{ agent_id: 'sess-A', team: 'default' }`
- **AND** `agents` table has a row with `agent_id='sess-A'`, `role='backend'`, `team='default'`

### Requirement: Repeated register_agent within same session updates metadata

If the same MCP session calls `register_agent` multiple times, the daemon SHALL upsert (update) the metadata without treating it as a conflict.

#### Scenario: Same session re-registers with different display_name

- **GIVEN** session `sess-A` has registered as `{ role: 'backend' }`
- **WHEN** the same session calls `register_agent({ model: 'opus-4-6', role: 'backend', display_name: 'alice' })`
- **THEN** the call succeeds
- **AND** the agents row's `display_name` becomes `'alice'`

### Requirement: agent_id collision across sessions returns 409

If a `register_agent` call arrives with an MCP session id that is already bound to a different, still-live TCP session, the daemon MUST return `{ error: 'agent_id_collision' }` with HTTP status 409 and log the collision as a daemon bug.

#### Scenario: Second TCP session reuses same agent_id

- **GIVEN** session `sess-A` is currently held by TCP connection C1
- **WHEN** a different TCP connection C2 presents `Mcp-Session-Id: sess-A` and calls `register_agent`
- **THEN** response is HTTP 409 with body `{ error: 'agent_id_collision' }`

### Requirement: Mismatched agent_id for session returns 403

If a tool call explicitly carries an `agent_id` parameter (where applicable) that does not match the caller's MCP session id, the daemon MUST return HTTP 403 with body `{ error: 'identity_mismatch' }`.

#### Scenario: send_message with spoofed from_agent_id

- **GIVEN** session `sess-A` is registered
- **WHEN** session `sess-A` calls any internal helper attempting to act as `sess-B`
- **THEN** the daemon rejects with 403 `{ error: 'identity_mismatch' }`

### Requirement: list_agents scoped to caller team

The `list_agents` MCP tool SHALL take `{ team?: string }` (defaults to caller's team) and return `{ agents: Array<{ agent_id, role, display_name?, model?, last_seen_at, online: boolean }> }`. `online` MUST be true when `last_seen_at` is within the last 5 minutes. Agents from other teams MUST NOT appear.

#### Scenario: Caller in team 'alpha' sees only team 'alpha' agents

- **GIVEN** two agents in team 'alpha' and three agents in team 'beta'
- **WHEN** a caller registered in team 'alpha' calls `list_agents({})`
- **THEN** the response contains exactly two agents, both with `team='alpha'`

#### Scenario: Online flag reflects last_seen_at freshness

- **GIVEN** agent `sess-A` last_seen_at is 2 minutes ago, `sess-B` is 10 minutes ago
- **WHEN** list_agents is called
- **THEN** `sess-A.online === true` and `sess-B.online === false`

### Requirement: last_seen_at updates on any tool invocation

Every MCP tool invocation by an authenticated agent SHALL update the caller's `agents.last_seen_at` to the current timestamp before returning.

#### Scenario: Tool call bumps last_seen_at

- **GIVEN** agent `sess-A` last_seen_at is 1 hour ago
- **WHEN** `sess-A` calls any tool (e.g. `list_agents`)
- **THEN** after the call, `agents.last_seen_at` for `sess-A` is within the last second
