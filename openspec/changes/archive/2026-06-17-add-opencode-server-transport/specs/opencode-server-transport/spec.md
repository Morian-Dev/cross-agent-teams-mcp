## ADDED Requirements

### Requirement: opencode-server dispatcher delivers poke via prompt_async HTTP POST

When the daemon dispatches a poke to a target with `delivery={ kind: 'opencode-server', session_id, base_url, auth_token_ref? }`, it SHALL issue a single HTTP request:

- Method: `POST`
- URL: `<base_url>/session/<session_id>/prompt_async`
- Request body: `{ parts: [{ type: 'text', text: <poke content> }], noReply: true }`
- Headers: `Content-Type: application/json`. If `auth_token_ref` resolves to a non-empty environment variable, additionally `Authorization: Bearer <resolved value>`.

On HTTP `204 No Content` (or any 2xx with empty body), the dispatcher SHALL return `{ ok: true, transport_used: 'opencode-server', session_id: <delivery.session_id> }`.

The dispatcher MUST NOT retry on non-2xx responses; the caller's auto-poke retry logic (in `mailbox`) governs retries uniformly across transports.

#### Scenario: Successful poke injects the prompt as a user message

- **GIVEN** target delivery is `{ kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888' }`
- **AND** the opencode server responds `204 No Content` to `POST /session/ses_abc/prompt_async`
- **WHEN** the daemon dispatches a poke with content `hello from daemon`
- **THEN** the dispatched HTTP request has body `{"parts":[{"type":"text","text":"hello from daemon"}],"noReply":true}`
- **AND** the dispatcher returns `{ ok: true, transport_used: 'opencode-server', session_id: 'ses_abc' }`

#### Scenario: Auth header attached when auth_token_ref resolves

- **GIVEN** target delivery is `{ kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888', auth_token_ref: 'OPENCODE_SERVER_PASSWORD' }`
- **AND** `process.env.OPENCODE_SERVER_PASSWORD` is set to `secret-token`
- **WHEN** the daemon dispatches a poke to that target
- **THEN** the dispatched HTTP request includes header `Authorization: Bearer secret-token`

#### Scenario: Auth header omitted when auth_token_ref is absent

- **GIVEN** target delivery is `{ kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888' }` (no `auth_token_ref`)
- **WHEN** the daemon dispatches a poke to that target
- **THEN** the dispatched HTTP request has NO `Authorization` header

### Requirement: opencode-server dispatcher resolves auth_token_ref as environment variable name

The `auth_token_ref` field, when present, is interpreted as the name of an environment variable to read at dispatch time. If the referenced environment variable is missing or empty/whitespace-only, the dispatcher SHALL fail before any network I/O with `{ error: 'missing_auth_token', detail: { ref: <auth_token_ref> } }`. The dispatcher MUST NOT treat `auth_token_ref` as an inline secret value.

#### Scenario: missing_auth_token when referenced env var is unset

- **GIVEN** target delivery is `{ kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:18888', auth_token_ref: 'OPENCODE_SERVER_PASSWORD' }`
- **AND** `process.env.OPENCODE_SERVER_PASSWORD` is missing or empty
- **WHEN** the daemon dispatches a poke to that target
- **THEN** the dispatcher returns `{ error: 'missing_auth_token', detail: { ref: 'OPENCODE_SERVER_PASSWORD' } }`
- **AND** no HTTP request is sent

### Requirement: opencode-server dispatcher maps HTTP failures to machine-readable error codes

The dispatcher SHALL return one of these error envelopes and NOT fall back to tmux or any other transport:

- Connection failure (fetch rejected, DNS error, ECONNREFUSED): `{ error: 'opencode_connect_failed', detail: <non-empty message>, transport_used: 'opencode-server' }`.
- Non-2xx HTTP response: `{ error: 'opencode_inject_failed', detail: { status: <status code>, body: <response body, truncated to 4KB> }, transport_used: 'opencode-server' }`. The detail.body MUST be a string; if the response body is JSON, it is serialized back to a string for inclusion.
- The dispatcher MAY treat HTTP 502/503/504 as connect-failed-equivalent for retry-classification purposes but MUST still report them as `opencode_inject_failed` to the caller.

#### Scenario: Connection refused maps to opencode_connect_failed

- **GIVEN** target delivery is `{ kind: 'opencode-server', session_id: 'ses_abc', base_url: 'http://127.0.0.1:9999' }`
- **AND** nothing is listening on `127.0.0.1:9999`
- **WHEN** the daemon dispatches a poke
- **THEN** the dispatcher returns `{ error: 'opencode_connect_failed', detail: <string mentioning ECONNREFUSED or similar>, transport_used: 'opencode-server' }`

#### Scenario: 404 from unknown session_id maps to opencode_inject_failed

- **GIVEN** target delivery is `{ kind: 'opencode-server', session_id: 'ses_ghost', base_url: 'http://127.0.0.1:18888' }`
- **AND** the opencode server responds `404 NotFound` with body `{"error":"session not found"}`
- **WHEN** the daemon dispatches a poke
- **THEN** the dispatcher returns `{ error: 'opencode_inject_failed', detail: { status: 404, body: <string containing "session not found"> }, transport_used: 'opencode-server' }`

#### Scenario: No tmux fallback when opencode-server dispatcher fails

- **GIVEN** target delivery is `{ kind: 'opencode-server', ... }` and the dispatcher returns `{ error: 'opencode_connect_failed', ... }`
- **WHEN** the dispatcher result is propagated by the poke dispatcher
- **THEN** the daemon MUST NOT attempt tmux paste injection as a fallback
- **AND** the poke response to the caller carries the same `opencode_connect_failed` error

### Requirement: free-xats-opencode launcher exports OPENCODE_XATS_BASE_URL and starts opencode with explicit port

The documented `free-xats-opencode` zsh function SHALL, in order:

1. Allocate a free TCP port on `127.0.0.1` (the implementation MAY use `node`/`bun`/`python3` one-liners or any equivalent mechanism that returns an unused port number without binding it permanently).
2. Export `OPENCODE_XATS_BASE_URL=http://127.0.0.1:<port>` to the environment that the opencode process will inherit.
3. `exec opencode --port <port> --hostname 127.0.0.1 "$@"`, preserving any user-supplied args.

The function MUST NOT call any daemon-side pre-registration. The function MUST NOT pass `--port 0` (default random), because the env var's port value must match the opencode server's actual listen port exactly.

The README documents the function as a copy-pasteable zsh snippet; it is not shipped as a repo file.

#### Scenario: free-xats-opencode exports base_url matching the opencode server's listen port

- **GIVEN** the `free-xats-opencode` zsh function is defined in the user's shell
- **WHEN** the user runs `free-xats-opencode`
- **THEN** the opencode process is started with `--port <N>` for some specific integer `N > 0`
- **AND** the opencode process's environment contains `OPENCODE_XATS_BASE_URL=http://127.0.0.1:<N>` with the same `N`
- **AND** an HTTP GET against `http://127.0.0.1:<N>/global/health` returns `{"healthy":true,...}` while opencode is running

#### Scenario: free-xats-opencode passes user args through to opencode

- **GIVEN** the `free-xats-opencode` zsh function is defined
- **WHEN** the user runs `free-xats-opencode --agent build --model glm-5.2`
- **THEN** the underlying opencode process is launched with both `--port <N>` AND the user's `--agent build --model glm-5.2` arguments

#### Scenario: Concurrent free-xats-opencode invocations get distinct ports

- **GIVEN** one `free-xats-opencode` invocation is already running with `OPENCODE_XATS_BASE_URL=http://127.0.0.1:18888`
- **WHEN** the user starts a second `free-xats-opencode` in a different terminal
- **THEN** the second invocation allocates a different free port (e.g., `18889`) and exports `OPENCODE_XATS_BASE_URL=http://127.0.0.1:<different port>`

### Requirement: Why this works now — launcher env dissolves the prior self-identification blocker

This requirement exists to anchor the design rationale and prevent future regression to the failed 2026-04-30 approach. The daemon SHALL treat the presence of `OPENCODE_XATS_BASE_URL` in the agent's shell environment as the sole sanctioned signal that the caller is opencode; no other opencode-identification signal (binary on PATH, process-name match, MCP client-info sniff) SHALL be promoted by the `register_agent` DETECTION block.

The 2026-04-30 `opencode-server` transport was deleted because its registration handshake required opencode's MCP runtime to self-identify as opencode, which its runtime could not do reliably (the runtime does not inject `OPENCODE_SESSION_ID` or any other identifying env var into its MCP subprocess, and the `x-opencode-session` HTTP header exists only on outbound LLM-provider calls, never on MCP-server calls).

The current design avoids that failure mode entirely: the user opts in via the `free-xats-opencode` launcher, which sets `OPENCODE_XATS_BASE_URL` in opencode's process environment. The agent reads this env via its Bash tool and explicitly passes the value into `register_agent({agent_type:'opencode', base_url})`. Identity is an explicit function argument, not an inferred runtime property.

The `register_agent` tool description's DETECTION block gains an env-based probe for opencode (`printenv OPENCODE_XATS_BASE_URL` non-empty), distinct from the previously-rejected `command -v opencode` binary-on-PATH probe. The env-based probe is sound because the env var exists ONLY when the user opted into the xats launcher — its presence is itself the runtime assertion. The PATH-based probe was unsound because it asserted runtime identity from system-wide state (what the user has installed), not session-local state.

#### Scenario: OPENCODE_XATS_BASE_URL env-based probe is the opencode DETECTION signal

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains the literal substring `OPENCODE_XATS_BASE_URL`
- **AND** that substring appears in the DETECTION block as the env-var probe for `agent_type='opencode'`
- **AND** the description string does NOT contain the literal substring `command -v opencode` (the rejected binary-on-PATH probe)

#### Scenario: register_agent description names agent_type=opencode with base_url argument

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains an opencode branch that instructs callers to pass `agent_type='opencode'` and `base_url=$OPENCODE_XATS_BASE_URL`
- **AND** the description string states that `session_id` SHOULD be omitted (daemon auto-resolves) but MAY be supplied as an override
