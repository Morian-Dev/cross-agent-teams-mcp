## ADDED Requirements

### Requirement: Agents table includes opencode transport columns

The `agents` table SHALL include two additional nullable columns:

- `opencode_base_url TEXT`
- `opencode_session_id TEXT`

These columns store the loopback opencode server base URL and the bound session id for server-based poke delivery.  `NULL` means the agent has not bound an opencode transport.

The columns are written by `bind_opencode_session`, NOT by `register_agent`.

#### Scenario: Fresh database creates opencode transport columns

- **WHEN** the daemon bootstraps a fresh `data.db`
- **THEN** `PRAGMA table_info('agents')` lists a column named `opencode_base_url`
- **AND** `PRAGMA table_info('agents')` lists a column named `opencode_session_id`
- **AND** rows inserted without those fields default to `NULL`

### Requirement: list_agents returns opencode transport fields

`list_agents` response entries SHALL include `opencode_base_url: string | null` and `opencode_session_id: string | null`, reflecting the persisted columns populated via `bind_opencode_session`.

#### Scenario: list_agents surfaces opencode transport binding

- **GIVEN** team `default` has agent `alice` with `opencode_base_url='http://127.0.0.1:4096'` and `opencode_session_id='sess-abc'`
- **AND** team `default` has agent `bob` with both fields `NULL`
- **WHEN** a caller in team `default` invokes `list_agents({})`
- **THEN** the entry for `alice` has `opencode_base_url: 'http://127.0.0.1:4096'`
- **AND** the entry for `alice` has `opencode_session_id: 'sess-abc'`
- **AND** the entry for `bob` has `opencode_base_url: null`
- **AND** the entry for `bob` has `opencode_session_id: null`
