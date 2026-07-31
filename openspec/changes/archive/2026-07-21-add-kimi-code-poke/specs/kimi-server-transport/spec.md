## ADDED Requirements

### Requirement: kimi-server dispatcher delivers poke via prompts HTTP POST

When the daemon dispatches a poke to a target with `delivery={ kind: 'kimi-server', session_id, base_url, auth_token_ref? }`, it SHALL issue a single HTTP request:

- Method: `POST`
- URL: `<base_url>/api/v1/sessions/<session_id>/prompts`
- Request body: `{ content: [{ type: 'text', text: <poke content> }] }`. The kimi server admits the prompt into the target session's prompt queue (active/queued/blocked), which wakes the session's agent loop.
- Headers: `Content-Type: application/json` and `Authorization: Bearer <resolved token>` (token resolution is defined in the auth requirement below; kimi server routes are bearer-protected by default).

On any 2xx response, the dispatcher SHALL return `{ ok: true, transport_used: 'kimi-server', session_id: <delivery.session_id> }` — unless the 2xx body is a JSON error envelope with a numeric non-zero `code` field, which is mapped to `kimi_inject_failed` per the error-mapping requirement below.

The dispatcher MUST NOT retry on non-2xx responses; the caller's auto-poke retry logic (in `mailbox`) governs retries uniformly across transports.

#### Scenario: Successful poke submits the prompt to the session queue

- **GIVEN** target delivery is `{ kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627' }`
- **AND** the kimi server responds `200` to `POST /api/v1/sessions/session_abc/prompts`
- **WHEN** the daemon dispatches a poke with content `hello from daemon`
- **THEN** the dispatched HTTP request has body `{"content":[{"type":"text","text":"hello from daemon"}]}`
- **AND** the dispatcher returns `{ ok: true, transport_used: 'kimi-server', session_id: 'session_abc' }`

#### Scenario: Bearer header attached from resolved token

- **GIVEN** target delivery is `{ kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627', auth_token_ref: 'KIMI_SERVER_TOKEN' }`
- **AND** `process.env.KIMI_SERVER_TOKEN` is set to `secret-token`
- **WHEN** the daemon dispatches a poke to that target
- **THEN** the dispatched HTTP request includes header `Authorization: Bearer secret-token`

### Requirement: kimi-server dispatcher resolves the bearer token from auth_token_ref or the kimi server token file

The dispatcher SHALL resolve the bearer token at dispatch time using this order:

1. If `auth_token_ref` is present, it is interpreted as the name of an environment variable to read. If the referenced environment variable is missing or empty/whitespace-only, the dispatcher SHALL fail before any network I/O with `{ error: 'missing_auth_token', detail: { ref: <auth_token_ref> } }`. The dispatcher MUST NOT treat `auth_token_ref` as an inline secret value.
2. If `auth_token_ref` is absent, the dispatcher SHALL read the kimi server's persisted token file at `~/.kimi-code/server.token` (the file the kimi server maintains across restarts; `kimi web rotate-token` invalidates it). If the file is missing, unreadable, or empty/whitespace-only, the dispatcher SHALL fail before any network I/O with `{ error: 'missing_auth_token', detail: { token_file: <path> } }`.

#### Scenario: missing_auth_token when referenced env var is unset

- **GIVEN** target delivery is `{ kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627', auth_token_ref: 'KIMI_SERVER_TOKEN' }`
- **AND** `process.env.KIMI_SERVER_TOKEN` is missing or empty
- **WHEN** the daemon dispatches a poke to that target
- **THEN** the dispatcher returns `{ error: 'missing_auth_token', detail: { ref: 'KIMI_SERVER_TOKEN' } }`
- **AND** no HTTP request is sent

#### Scenario: token read from default token file when auth_token_ref is absent

- **GIVEN** target delivery is `{ kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627' }` (no `auth_token_ref`)
- **AND** `~/.kimi-code/server.token` contains `file-token`
- **WHEN** the daemon dispatches a poke
- **THEN** the dispatched HTTP request includes header `Authorization: Bearer file-token`

#### Scenario: missing_auth_token when token file is absent

- **GIVEN** target delivery is `{ kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627' }` (no `auth_token_ref`)
- **AND** `~/.kimi-code/server.token` does not exist
- **WHEN** the daemon dispatches a poke
- **THEN** the dispatcher returns `{ error: 'missing_auth_token', detail: { token_file: <path> } }`
- **AND** no HTTP request is sent

### Requirement: kimi-server dispatcher maps HTTP failures to machine-readable error codes

The dispatcher SHALL return one of these error envelopes and NOT fall back to tmux or any other transport:

- Connection failure (fetch rejected, DNS error, ECONNREFUSED): `{ error: 'kimi_connect_failed', detail: <non-empty message>, transport_used: 'kimi-server' }`.
- Non-2xx HTTP response: `{ error: 'kimi_inject_failed', detail: { status: <status code>, body: <response body, truncated to 4KB> }, transport_used: 'kimi-server' }`. The detail.body MUST be a string; if the response body is JSON, it is serialized back to a string for inclusion.
- 2xx response whose JSON body is an error envelope with a numeric non-zero `code` field: the kimi server reports application-level failures (e.g. unknown `session_id`) as HTTP 200 with a body like `{"code":40401,"msg":"session ... does not exist",...}` instead of a non-2xx status. The dispatcher SHALL treat any 2xx response whose body parses as JSON with a numeric `code !== 0` as `{ error: 'kimi_inject_failed', detail: { status: <status code>, body: <response body, truncated to 4KB> }, transport_used: 'kimi-server' }`. A 2xx response with an empty body, a non-JSON body, or a JSON body without a numeric non-zero `code` field is a success.

#### Scenario: Connection refused maps to kimi_connect_failed

- **GIVEN** target delivery is `{ kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:9999' }`
- **AND** nothing is listening on `127.0.0.1:9999`
- **WHEN** the daemon dispatches a poke
- **THEN** the dispatcher returns `{ error: 'kimi_connect_failed', detail: <string mentioning ECONNREFUSED or similar>, transport_used: 'kimi-server' }`

#### Scenario: Unknown session_id maps to kimi_inject_failed despite HTTP 200

- **GIVEN** target delivery is `{ kind: 'kimi-server', session_id: 'session_ghost', base_url: 'http://127.0.0.1:58627' }`
- **AND** the kimi server responds `200` with an error-envelope body `{"code":40401,"msg":"session session_ghost does not exist","data":null}` (the kimi server's real behavior for an unknown session)
- **WHEN** the daemon dispatches a poke
- **THEN** the dispatcher returns `{ error: 'kimi_inject_failed', detail: { status: 200, body: <string containing "does not exist"> }, transport_used: 'kimi-server' }`

#### Scenario: Non-2xx response maps to kimi_inject_failed

- **GIVEN** target delivery is `{ kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627' }`
- **AND** the kimi server responds `500` with body `internal error`
- **WHEN** the daemon dispatches a poke
- **THEN** the dispatcher returns `{ error: 'kimi_inject_failed', detail: { status: 500, body: 'internal error' }, transport_used: 'kimi-server' }`

#### Scenario: No tmux fallback when kimi-server dispatcher fails

- **GIVEN** target delivery is `{ kind: 'kimi-server', ... }` and the dispatcher returns `{ error: 'kimi_connect_failed', ... }`
- **WHEN** the dispatcher result is propagated by the poke dispatcher
- **THEN** the daemon MUST NOT attempt tmux paste injection as a fallback
- **AND** the poke response to the caller carries the same `kimi_connect_failed` error

### Requirement: xats-kimi launcher pre-creates the session and exports KIMI_XATS_BASE_URL + KIMI_XATS_SESSION_ID

The documented `xats-kimi` zsh function SHALL, in order:

1. Resolve the base URL as `${KIMI_XATS_BASE_URL:-http://127.0.0.1:58627}` (the `kimi web` default bind port).
2. Ensure a kimi server is reachable at that base URL: if nothing is listening, start one via `kimi web --no-open` (`kimi server run` is deprecated as of kimi 0.28.0; the old 60s idle-exit no longer exists, so no `--keep-alive` flag is needed or available). If the start fails, print an error and abort without launching kimi.
3. Pre-create the target session via the kimi server REST API: `POST <base_url>/api/v1/sessions` with `{ "title": <label>, "metadata": { "cwd": <current directory> } }` and the bearer token read from `~/.kimi-code/server.token`; abort with an error if session creation fails. Pre-creation is REQUIRED because it yields the exact `session_id` — deriving it from `~/.kimi-code/session_index.jsonl` is unsound when several kimi sessions share a workDir (the last matching entry can be a different session, and pokes then wake that wrong session while reporting `delivered`).
4. Set the session's model and permission mode via `POST <base_url>/api/v1/sessions/<session_id>/profile` with `{ "agent_config": { "model": <default_model from ~/.kimi-code/config.toml>, "permission_mode": "yolo" } }`. Both are REQUIRED: server-created sessions carry no model, so server-driven turns fail instantly with `model.not_configured`; and server-driven turns use the session's permission mode (default `manual`), NOT the `--yolo` flag passed to the CLI — without `permission_mode: "yolo"` every tool call in a poke-woken turn blocks on an approval nobody will answer.
5. Fire one trivial init prompt (`POST <base_url>/api/v1/sessions/<session_id>/prompts`) and wait until the session's `agents/main` directory exists on disk. This is REQUIRED because the kimi CLI refuses to attach (`Agent "main" was not found`) a server-created session whose agent state has not been materialized by a first turn.
6. Export `KIMI_XATS_BASE_URL=<resolved base URL>` and `KIMI_XATS_SESSION_ID=<created session id>` to the environment that the kimi process will inherit.
7. `exec kimi --session <session_id> --yolo "$@"`, preserving any user-supplied args.

The function MUST NOT call any daemon-side pre-registration. The env vars are set ONLY by this launcher, so their presence is itself the runtime assertion that the caller is kimi-code (same opt-in pattern as `OPENCODE_XATS_BASE_URL`).

The function is documented as a copy-pasteable zsh snippet; it is not shipped as a repo file.

#### Scenario: xats-kimi exports the exact pre-created session id

- **GIVEN** a kimi server is listening on `127.0.0.1:58627`
- **WHEN** the user runs `xats-kimi`
- **THEN** a new session is created via `POST /api/v1/sessions` with `metadata.cwd` equal to the current directory
- **AND** the kimi process is launched with `--session <that exact id> --yolo` and both `KIMI_XATS_BASE_URL` and `KIMI_XATS_SESSION_ID` in its environment
- **AND** an agent inside that session passing `session_id=$KIMI_XATS_SESSION_ID` to `register_agent` binds pokes to the session the user is actually looking at

#### Scenario: xats-kimi starts the kimi server when absent

- **GIVEN** nothing is listening on `127.0.0.1:58627`
- **WHEN** the user runs `xats-kimi`
- **THEN** `kimi web --no-open` is executed first
- **AND** session pre-creation and the kimi launch happen only after the server port is reachable

#### Scenario: xats-kimi aborts when session pre-creation fails

- **GIVEN** the kimi server is reachable but `POST /api/v1/sessions` fails (or returns no `id`)
- **WHEN** the user runs `xats-kimi`
- **THEN** the function prints an error and does NOT launch kimi (launching without `KIMI_XATS_SESSION_ID` would recreate the session_index-guessing failure mode)

#### Scenario: xats-kimi passes user args through to kimi

- **GIVEN** the `xats-kimi` zsh function is defined
- **WHEN** the user runs `xats-kimi --model kimi-code/kimi-for-coding`
- **THEN** the underlying kimi process is launched with `--session <id>`, `--yolo`, AND `--model kimi-code/kimi-for-coding`

### Requirement: start-xats and stop-xats manage the kimi server lifecycle

The documented `start-xats` zsh function SHALL, in addition to its existing daemon/codex behavior, ensure a kimi server is running when the `kimi` binary is available:

- If the kimi server port (default `58627`, or the port parsed from `$KIMI_XATS_BASE_URL` when set) is already listening, report "already running" and do nothing.
- Otherwise run `kimi web --no-open` in the background and wait for the port to become reachable, logging success/failure through the existing `_xats-log-event` mechanism.
- If no `kimi` binary is found on PATH, skip silently (same pattern as the codex-app skip).

The documented `stop-xats` zsh function SHALL stop the kimi server via `kimi web kill` (falling back to killing the listener on the kimi server port if the subcommand fails, e.g. for a server started by an older kimi that `kimi web ps` cannot see), after stopping the xats daemon.

#### Scenario: start-xats starts kimi server when port is free

- **GIVEN** the `kimi` binary is on PATH and nothing listens on `127.0.0.1:58627`
- **WHEN** the user runs `start-xats`
- **THEN** `kimi web --no-open` is executed
- **AND** `start-xats` reports the kimi server as ready once the port is reachable

#### Scenario: start-xats skips kimi server when already running

- **GIVEN** a kimi server is already listening on `127.0.0.1:58627`
- **WHEN** the user runs `start-xats`
- **THEN** no second kimi server is started

#### Scenario: stop-xats stops the kimi server

- **GIVEN** a kimi server is listening on `127.0.0.1:58627`
- **WHEN** the user runs `stop-xats`
- **THEN** `kimi web kill` is executed
- **AND** after the function returns, nothing listens on `127.0.0.1:58627`

### Requirement: kimi-code self-identification uses launcher-exported session id

The daemon SHALL treat the presence of `KIMI_XATS_BASE_URL` in the agent's shell environment as the sole sanctioned signal that the caller is kimi-code; no other kimi-identification signal (binary on PATH, process-name match, MCP client-info sniff) SHALL be promoted by the `register_agent` DETECTION block.

Kimi Code does not inject its session id into the MCP subprocess environment, and the kimi REST API has no "which session am I" endpoint usable from inside a session. The sanctioned way for the agent to learn its `session_id` is the `KIMI_XATS_SESSION_ID` environment variable, which the `xats-kimi` launcher exports after pre-creating the session via the kimi server REST API. The `register_agent` DETECTION block SHALL instruct kimi-code callers to pass `session_id` from `$KIMI_XATS_SESSION_ID`.

Deriving `session_id` from `~/.kimi-code/session_index.jsonl` (the last `workDir`-matching entry) is UNSOUND and SHALL NOT be promoted: when several kimi sessions share a workDir, the last entry can belong to a different session — pokes are then delivered to that wrong session (which may even wake up and answer mail) while the session the user is watching never reacts.

#### Scenario: KIMI_XATS_BASE_URL env-based probe is the kimi-code DETECTION signal

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains the literal substring `KIMI_XATS_BASE_URL`
- **AND** that substring appears in the DETECTION block as the env-var probe for `agent_type='kimi-code'`

#### Scenario: DETECTION block instructs KIMI_XATS_SESSION_ID for session_id

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains the literal substring `KIMI_XATS_SESSION_ID`
- **AND** instructs kimi-code callers to pass `session_id` from `$KIMI_XATS_SESSION_ID` (it is REQUIRED, there is no daemon auto-resolution)
