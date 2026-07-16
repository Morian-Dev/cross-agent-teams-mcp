## MODIFIED Requirements

### Requirement: register_agent registers a Codex app-server delivery without implicit tmux binding

The daemon SHALL expose Codex app-server registration through `register_agent({ agent_type: 'codex', ... })`.  For Codex callers, the tool accepts the normal identity fields plus optional `ws_url`, `auth_token_ref`, and `thread_id`.  It SHALL:

1. Resolve one or more Codex app-server websocket candidates from explicit input, the legacy single-endpoint environment override, the multi-endpoint environment configuration, or the built-in default.
2. Initialize the Codex protocol for each selected candidate needed to identify the target runtime.
3. If `thread_id` is provided, attempt `thread/resume` only for that thread id and register only when exactly one candidate accepts it.
4. If `thread_id` is omitted, preserve the existing single-endpoint diagnostic flow: call `thread/loaded/list`, attempt `thread/resume` against the loaded thread ids, and return `{ error: 'thread_id_required', detail: { ws_url, thread_ids: [...] } }` instead of registering any thread.
5. Register the caller as `delivery.kind='codex-appserver'` only after a caller-supplied `thread_id` has been confirmed resumable on exactly one endpoint.
6. Leave tmux pane binding unchanged.  If the caller wants tmux fallback delivery, it MUST rely on the normal runtime-binding path or invoke `bind_runtime_identity(...)` explicitly afterward.

The daemon MUST NOT infer the caller's current Codex thread solely from the set of loaded or resumable threads.  The tool surface MUST reject Codex-only top-level fields unless `agent_type='codex'`.  When no new usable pane id is available, the persisted `tmux_pane_id` follows the normal registration semantics: omit on first insert yields `NULL`, omit on re-registration preserves the existing value.

The Codex registration path is Codex-only.  If no candidate websocket endpoint is reachable or speaks the expected Codex protocol, the tool SHALL return `{error: 'unsupported_client', detail: { expected: 'codex', reason: ..., ws_url, cause? }}` rather than guessing.  If multiple candidates accept the same `thread_id`, it SHALL return `{ error: 'codex_endpoint_ambiguous', detail: { thread_id, ws_urls } }` without mutating an agent row.

#### Scenario: register_agent registers a caller-supplied Codex thread_id without changing tmux pane state

- **GIVEN** the caller invokes `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5', team: 'default', role: 'worker', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** exactly one configured candidate accepts `thread/resume` for `11111111-1111-4111-8111-111111111111`
- **WHEN** the tool completes successfully
- **THEN** it returns `{ agent_id, team: 'default', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: '<matched-url>' }`
- **AND** the caller's `agents` row is persisted with `delivery.kind='codex-appserver'` and the matched URL
- **AND** the tool does not require tmux pane discovery to succeed

#### Scenario: register_agent rejects Codex thread inputs without agent_type=codex

- **WHEN** a caller invokes `register_agent({ agent_type: 'custom', name: 'lead', model: 'gpt-5', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **THEN** the MCP tool schema rejects the request as carrying an unknown top-level key
- **AND** the tool does not accept Codex-only fields unless `agent_type='codex'`

#### Scenario: explicit runtime binding can follow Codex register_agent

- **GIVEN** the caller first succeeds with `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** the caller still has no usable persisted `tmux_pane_id`
- **WHEN** the caller later invokes `bind_runtime_identity(...)` successfully
- **THEN** the existing `delivery.kind='codex-appserver'` remains intact
- **AND** the caller row gains the verified `tmux_pane_id` written by the runtime-binding path

#### Scenario: re-registration preserves existing pane when no new pane is found

- **GIVEN** agent `(default, lead)` already exists with `tmux_pane_id='%42'`
- **AND** the caller invokes `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5', team: 'default', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** exactly one configured candidate accepts `thread/resume`
- **AND** Codex tmux pane detection returns `not_found`
- **WHEN** the tool completes successfully
- **THEN** the caller's `agents` row keeps `tmux_pane_id='%42'`
- **AND** the caller's `agents` row is updated with the newly confirmed `delivery.kind='codex-appserver'`

#### Scenario: register_agent requires explicit thread_id when resumable threads exist for Codex

- **GIVEN** the caller invokes `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5' })`
- **AND** the selected single websocket endpoint reports resumable thread ids `['11111111-1111-4111-8111-111111111111']`
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'thread_id_required', detail: { ws_url, thread_ids: ['11111111-1111-4111-8111-111111111111'] } }`
- **AND** no `agents` row is inserted or updated for the caller

#### Scenario: register_agent returns no_loaded_threads for Codex

- **GIVEN** the caller invokes `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5' })`
- **AND** the selected single Codex app-server reports zero loaded threads
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'no_loaded_threads', detail: { ws_url } }`

#### Scenario: register_agent returns codex_resume_failed for an explicit thread_id

- **GIVEN** the caller invokes `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** no initialized candidate accepts `thread/resume`
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'codex_resume_failed', detail: { thread_id: '11111111-1111-4111-8111-111111111111', attempts: [...] } }`

#### Scenario: register_agent rejects an ambiguous Codex endpoint match

- **GIVEN** two configured app-server candidates both accept `thread/resume` for the caller's `thread_id`
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'codex_endpoint_ambiguous', detail: { thread_id, ws_urls } }`
- **AND** no `agents` row is inserted or updated for the caller

#### Scenario: register_agent returns unsupported_client outside Codex

- **GIVEN** the caller invokes `register_agent({ agent_type: 'codex', name: 'lead', model: 'gpt-5', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** every selected websocket endpoint is unreachable or does not implement the Codex protocol
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'unsupported_client', detail: { expected: 'codex', reason: ..., ws_url, cause? } }`

### Requirement: register_agent({agent_type:'codex'}) defaults ws_url to empty string when omitted

When `register_agent` is invoked with `agent_type='codex'` and `ws_url` is omitted, the daemon SHALL set `ws_url=''` before invoking the codex-appserver path.  `RegisterCodexSelfService` SHALL resolve candidates using this precedence: explicit non-empty `ws_url`, legacy `CROSS_AGENT_TEAMS_CODEX_WS_URL`, JSON array `CROSS_AGENT_TEAMS_CODEX_WS_URLS`, then built-in `ws://127.0.0.1:8799`.  Invalid multi-endpoint JSON or non-WebSocket entries SHALL be rejected as configuration errors before registration mutates state.

#### Scenario: agent_type='codex' without ws_url uses the built-in default

- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:'<uuid>'})` without `ws_url`
- **AND** neither endpoint environment variable is configured
- **THEN** the daemon connects to `ws://127.0.0.1:8799`
- **AND** the returned `ws_url` reflects that default

#### Scenario: agent_type='codex' without ws_url honors legacy environment override

- **GIVEN** the daemon process environment has `CROSS_AGENT_TEAMS_CODEX_WS_URL=ws://127.0.0.1:8899`
- **AND** it also has a multi-endpoint configuration
- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:'<uuid>'})` without `ws_url`
- **THEN** the daemon connects only to the legacy env-override URL
- **AND** the returned `ws_url` is `ws://127.0.0.1:8899`

#### Scenario: agent_type='codex' auto-matches a multi-endpoint runtime

- **GIVEN** `CROSS_AGENT_TEAMS_CODEX_WS_URLS` is `["ws://127.0.0.1:8799","ws://127.0.0.1:8800"]`
- **AND** only the second endpoint accepts the caller's `thread_id`
- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:'<uuid>'})` without `ws_url`
- **THEN** the returned `ws_url` is `ws://127.0.0.1:8800`

#### Scenario: invalid multi-endpoint configuration fails closed

- **GIVEN** `CROSS_AGENT_TEAMS_CODEX_WS_URLS` is invalid JSON or contains a non-`ws` URL
- **WHEN** a Codex caller omits `ws_url`
- **THEN** registration returns a machine-readable configuration error
- **AND** no `agents` row is inserted or updated
