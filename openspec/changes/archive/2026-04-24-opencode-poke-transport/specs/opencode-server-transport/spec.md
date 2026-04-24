## ADDED Requirements

### Requirement: bind_opencode_session writes opencode session metadata to caller row

The daemon SHALL register an MCP tool `bind_opencode_session({base_url: string, session_id: string})` for self-binding an opencode host to its active server session.  The caller identity is resolved from the session, and the tool MUST update only the caller's own row.

When invoked:

1. The caller MUST be a registered agent, otherwise return `{ error: 'unknown_agent' }`.
2. `base_url` MUST be a trimmed non-empty absolute URL, otherwise return `{ error: 'invalid_opencode_base_url' }`.
3. The URL host MUST resolve to loopback form only: `127.0.0.1`, `localhost`, or `::1`.  Any other host MUST be rejected with `{ error: 'invalid_opencode_base_url' }`.
4. `session_id` MUST be a trimmed non-empty string, otherwise return `{ error: 'invalid_opencode_session_id' }`.
5. On success, the daemon MUST update `agents.opencode_base_url` and `agents.opencode_session_id` for the caller and return `{ ok: true }`.

#### Scenario: bind_opencode_session updates caller row

- **GIVEN** agent `alice` is the MCP session caller and has `opencode_base_url=NULL`, `opencode_session_id=NULL`
- **WHEN** `alice` invokes `bind_opencode_session({base_url:'http://127.0.0.1:4096', session_id:'sess-abc'})`
- **THEN** the response is `{ ok: true }`
- **AND** the agents row for `alice` has `opencode_base_url='http://127.0.0.1:4096'`
- **AND** the agents row for `alice` has `opencode_session_id='sess-abc'`

#### Scenario: bind_opencode_session rejects non-loopback base_url

- **GIVEN** agent `alice` is the MCP session caller
- **WHEN** `alice` invokes `bind_opencode_session({base_url:'http://10.0.0.5:4096', session_id:'sess-abc'})`
- **THEN** the response is `{ error: 'invalid_opencode_base_url' }`
- **AND** the agents row for `alice` is unchanged

#### Scenario: bind_opencode_session rejects blank session id

- **GIVEN** agent `alice` is the MCP session caller
- **WHEN** `alice` invokes `bind_opencode_session({base_url:'http://localhost:4096', session_id:'   '})`
- **THEN** the response is `{ error: 'invalid_opencode_session_id' }`
- **AND** the agents row for `alice` is unchanged

### Requirement: Direct poke can deliver through opencode server session

When `poke({target_agent_id, prompt})` selects the opencode transport, the daemon SHALL invoke the target session through opencode's server/session prompt API using the stored `opencode_base_url` and `opencode_session_id`.  The transport MUST inject the provided `prompt` as a user prompt for that session and request an asynchronous reply, matching the existing tmux `paste + Enter` semantics.

On success, the response MUST be `{ ok: true, transport_used: 'opencode-server', base_url: <target base_url>, session_id: <target session_id> }`.

#### Scenario: direct poke succeeds through opencode server

- **GIVEN** target agent `bob` has `opencode_base_url='http://127.0.0.1:4096'` and `opencode_session_id='sess-bob'`
- **AND** the opencode server is reachable at that base URL
- **AND** session `sess-bob` exists and accepts async prompt requests
- **WHEN** `alice` calls `poke({target_agent_id:'bob', prompt:'POC poke from external client'})`
- **THEN** the response is `{ ok: true, transport_used: 'opencode-server', base_url: 'http://127.0.0.1:4096', session_id: 'sess-bob' }`
- **AND** the daemon does NOT execute any tmux command

### Requirement: opencode transport surfaces classified delivery errors

When opencode transport is selected and the request cannot be completed, the daemon MUST return one of the following error envelopes:

- `{ error: 'opencode_session_not_bound' }` when either `opencode_base_url` or `opencode_session_id` is missing after transport selection reaches opencode.
- `{ error: 'opencode_unreachable', detail: <string> }` when the daemon cannot connect to the opencode server.
- `{ error: 'opencode_session_not_found', detail: <string | object> }` when the server reports the target session does not exist.
- `{ error: 'opencode_session_busy', detail: <string | object> }` when the server reports the target session is already processing another turn.
- `{ error: 'opencode_request_failed', detail: <string | object> }` for other non-success responses from the opencode server.

The daemon MUST NOT silently downgrade an opencode server error into a success, and MUST NOT attempt tmux fallback after a classified opencode error for the same call.

#### Scenario: missing opencode binding returns session_not_bound

- **GIVEN** target agent `bob` has `opencode_base_url='http://127.0.0.1:4096'` and `opencode_session_id=NULL`
- **AND** `bob` has no `tmux_pane_id`
- **WHEN** `alice` calls `poke({target_agent_id:'bob', prompt:'p'})`
- **THEN** the response is `{ error: 'opencode_session_not_bound' }`

#### Scenario: unreachable server returns opencode_unreachable

- **GIVEN** target `bob` has `opencode_base_url='http://127.0.0.1:4096'` and `opencode_session_id='sess-bob'`
- **AND** no process is listening on `127.0.0.1:4096`
- **WHEN** `alice` calls `poke({target_agent_id:'bob', prompt:'p'})`
- **THEN** the response is `{ error: 'opencode_unreachable', detail: <non-empty string> }`

#### Scenario: missing session returns opencode_session_not_found

- **GIVEN** target `bob` has `opencode_base_url='http://127.0.0.1:4096'` and `opencode_session_id='sess-missing'`
- **AND** the opencode server is reachable but has no session `sess-missing`
- **WHEN** `alice` calls `poke({target_agent_id:'bob', prompt:'p'})`
- **THEN** the response is `{ error: 'opencode_session_not_found', detail: <non-empty string or object> }`

#### Scenario: busy session returns opencode_session_busy

- **GIVEN** target `bob` has `opencode_base_url='http://127.0.0.1:4096'` and `opencode_session_id='sess-bob'`
- **AND** session `sess-bob` is already processing another turn
- **WHEN** `alice` calls `poke({target_agent_id:'bob', prompt:'p'})`
- **THEN** the response is `{ error: 'opencode_session_busy', detail: <non-empty string or object> }`
