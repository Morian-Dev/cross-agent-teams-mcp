## ADDED Requirements

### Requirement: Codex dispatcher opens websocket using ws_url and optional auth token reference

When the daemon dispatches a poke to a target with `delivery={ kind: 'codex-appserver', thread_id, ws_url, auth_token_ref? }`, it SHALL create a websocket client connection to `ws_url`.

If `auth_token_ref` is absent, the dispatcher SHALL connect without an Authorization header.

If `auth_token_ref` is present, the dispatcher SHALL resolve it as an environment variable name.  The referenced environment variable MUST exist and contain a trimmed non-empty string.  The dispatcher SHALL send that value as a bearer token during websocket connection setup.  If the environment variable is missing or blank, the dispatcher SHALL fail before any network I/O with `{ error: 'missing_auth_token', detail: { ref: <auth_token_ref> } }`.

#### Scenario: Connects without auth when auth_token_ref omitted

- **GIVEN** target delivery is `{ kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799' }`
- **WHEN** the daemon dispatches a poke to that target
- **THEN** it opens a websocket connection to `ws://127.0.0.1:8799` without an Authorization header

#### Scenario: Resolves auth token from environment variable

- **GIVEN** target delivery includes `auth_token_ref: 'CODEX_REMOTE_TOKEN'`
- **AND** `process.env.CODEX_REMOTE_TOKEN` is set to a non-empty token
- **WHEN** the daemon dispatches a poke to that target
- **THEN** it uses the resolved token as bearer auth during websocket connection setup

#### Scenario: Missing auth token reference fails before connect

- **GIVEN** target delivery includes `auth_token_ref: 'CODEX_REMOTE_TOKEN'`
- **AND** `process.env.CODEX_REMOTE_TOKEN` is missing or blank
- **WHEN** the daemon dispatches a poke to that target
- **THEN** the dispatcher returns `{ error: 'missing_auth_token', detail: { ref: 'CODEX_REMOTE_TOKEN' } }`
- **AND** no websocket connection is attempted

### Requirement: Codex dispatcher performs initialize, resume, and turn/start sequence

After opening the websocket, the dispatcher SHALL execute the following protocol sequence against Codex app-server:

1. Send `initialize` with client metadata identifying the daemon.
2. Send the `initialized` notification.
3. Send `thread/resume` for `delivery.thread_id`.
4. Send `turn/start` with the poke text as a single text input item.

The dispatcher SHALL wait for a successful response from each request step before proceeding to the next one.  On success it SHALL close the websocket and return `{ ok: true, transport_used: 'codex-appserver', thread_id: <delivery.thread_id> }`.

#### Scenario: Successful poke injects the prompt into the target thread

- **GIVEN** target delivery is `{ kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799' }`
- **AND** the app-server accepts `initialize`, `thread/resume`, and `turn/start`
- **WHEN** the daemon dispatches a poke with prompt `hello from daemon`
- **THEN** it sends `initialize`, then `initialized`, then `thread/resume`, then `turn/start`
- **AND** the `turn/start` payload contains exactly one text input item with text `hello from daemon`
- **AND** the final result is `{ ok: true, transport_used: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111' }`

### Requirement: Codex dispatcher maps connection and RPC failures to machine-readable errors

If websocket connection setup fails, the dispatcher SHALL return `{ error: 'codex_connect_failed', detail: <non-empty detail> }`.

If `initialize` returns an RPC error, the dispatcher SHALL return `{ error: 'codex_initialize_failed', detail: <rpc error payload> }`.

If `thread/resume` returns an RPC error, the dispatcher SHALL return `{ error: 'codex_resume_failed', detail: <rpc error payload> }`.

If `turn/start` returns an RPC error, the dispatcher SHALL return `{ error: 'codex_turn_start_failed', detail: <rpc error payload> }`.

For all of the above failures, the dispatcher SHALL close the websocket before returning.

#### Scenario: initialize failure maps to codex_initialize_failed

- **GIVEN** the websocket connection succeeds
- **AND** the app-server returns a JSON-RPC error for `initialize`
- **WHEN** the daemon dispatches a poke
- **THEN** the result is `{ error: 'codex_initialize_failed', detail: <rpc error payload> }`

#### Scenario: thread resume failure maps to codex_resume_failed

- **GIVEN** `initialize` succeeds
- **AND** the app-server returns a JSON-RPC error for `thread/resume`
- **WHEN** the daemon dispatches a poke
- **THEN** the result is `{ error: 'codex_resume_failed', detail: <rpc error payload> }`

#### Scenario: turn start failure maps to codex_turn_start_failed

- **GIVEN** `initialize` and `thread/resume` both succeed
- **AND** the app-server returns a JSON-RPC error for `turn/start`
- **WHEN** the daemon dispatches a poke
- **THEN** the result is `{ error: 'codex_turn_start_failed', detail: <rpc error payload> }`

#### Scenario: websocket dial failure maps to codex_connect_failed

- **GIVEN** the websocket endpoint is unreachable
- **WHEN** the daemon dispatches a poke
- **THEN** the result is `{ error: 'codex_connect_failed', detail: <non-empty detail> }`
