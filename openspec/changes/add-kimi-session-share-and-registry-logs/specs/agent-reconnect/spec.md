## ADDED Requirements

### Requirement: reconnect recovers kimi-code identity by base_url and session_id

`reconnect({ base_url, session_id })` SHALL recover a kimi-code identity, mirroring the opencode shape: reverse-look-up local agents rows whose delivery is `{ kind: 'kimi-server' }` matching the given `(base_url, session_id)` pair, and rebind the calling MCP session to the single matching identity.

Unlike opencode, `session_id` is REQUIRED for the kimi path: the daemon MUST NOT auto-resolve "the most recent session" for kimi, for the same reason registration refuses to guess — several kimi sessions routinely share a workDir, and binding the wrong one delivers pokes to a session nobody is watching while reporting success.

Before reusing the identity the daemon MUST revalidate the session against the kimi server: `GET <base_url>/api/v1/sessions/<session_id>` with the bearer token resolved exactly as the poke dispatcher resolves it (delivery `auth_token_ref`, else the kimi token file). On a missing/archived session or a failed probe, reconnect SHALL return `session_not_found` and MUST NOT mutate any agents row or binding.

On zero matching rows, reconnect SHALL return `need_register`. On success it SHALL rebind the current connection under the recovered identity's stable runtime key (the kimi `session_id`), so the recovered connection co-exists with — rather than takes over — any live engine connection of the same session.

#### Scenario: kimi identity recovered and rebound

- **GIVEN** a local agents row `(default, kimi-1)` with delivery `{ kind: 'kimi-server', session_id: 'S', base_url: 'http://127.0.0.1:58627' }`
- **AND** the kimi server reports session `S` exists
- **WHEN** a fresh MCP session calls `reconnect({ base_url: 'http://127.0.0.1:58627', session_id: 'S' })`
- **THEN** the response carries the row's `(team, name, agent_id)`
- **AND** the calling session is bound to that `agent_id`

#### Scenario: Stale session id does not rebind

- **GIVEN** the same row, but the kimi server reports session `S` does not exist (or the probe fails)
- **WHEN** `reconnect({ base_url, session_id: 'S' })` is called
- **THEN** the response is `session_not_found`
- **AND** no agents row or binding is mutated

#### Scenario: No matching row asks for registration

- **GIVEN** no local `kimi-server` row matches `(base_url, session_id)`
- **WHEN** `reconnect({ base_url, session_id })` is called
- **THEN** the response indicates `need_register`

#### Scenario: session_id is required for the kimi path

- **GIVEN** a caller supplying a kimi `base_url` without `session_id` in a context where the base_url hosts kimi-server rows
- **WHEN** the daemon resolves the reconnect
- **THEN** the kimi rows are not auto-resolved by recency; recovery of a kimi identity without an explicit `session_id` is refused
