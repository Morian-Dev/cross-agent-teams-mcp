## MODIFIED Requirements

### Requirement: register_codex_self autodetects and registers a Codex app-server delivery

The daemon SHALL expose a tool `register_codex_self` for Codex remote sessions.  The tool accepts human-facing identity fields such as `name`, `team`, and `role`, plus optional `ws_url`, `auth_token_ref`, `thread_id`, `tmux_pane_id`, `cwd`, `tty`, and `title_contains`.  It SHALL:

1. Connect to the Codex app-server websocket, defaulting `ws_url` to `ws://127.0.0.1:8799` when not provided.
2. Initialize the Codex protocol.
3. If `thread_id` is provided, attempt `thread/resume` only for that thread id.
4. If `thread_id` is omitted, call `thread/loaded/list`, attempt `thread/resume` against the loaded thread ids, and return `{ error: 'thread_id_required', detail: { ws_url, thread_ids: [...] } }` instead of registering any thread.
5. Register the caller as `delivery.kind='codex-appserver'` only after a caller-supplied `thread_id` has been confirmed resumable.
6. Persist a `tmux_pane_id` alongside the Codex delivery when either:
   - the caller supplied a usable `tmux_pane_id`, or
   - the caller omitted `tmux_pane_id` and the tool can derive a single Codex tmux pane via the existing Codex pane-detection logic, optionally narrowed by `cwd`, `tty`, or `title_contains`.
7. Treat tmux pane capture as best-effort.  If pane detection returns `not_found`, `ambiguous_match`, or `tmux_unavailable`, the tool MUST still succeed with the Codex delivery registration and MUST NOT fail the overall call solely because tmux pane discovery was incomplete.

The daemon MUST NOT infer the caller's current Codex thread solely from the set of loaded or resumable threads.  When a usable `tmux_pane_id` is supplied directly, the tool MUST prefer that explicit value and MUST NOT replace it with detector output.  When no new usable pane id is available, the persisted `tmux_pane_id` follows the normal registration semantics: omit on first insert yields `NULL`, omit on re-registration preserves the existing value.

The tool is Codex-only.  If the websocket endpoint is unreachable or does not speak the expected Codex protocol, the tool SHALL return `{error: 'unsupported_client', detail: { expected: 'codex', reason: ..., ws_url, cause? }}` rather than guessing.

#### Scenario: register_codex_self registers a caller-supplied thread_id and detected pane

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead', team: 'default', role: 'worker', thread_id: '11111111-1111-4111-8111-111111111111', cwd: '/workspace/project' })`
- **AND** `thread/resume` succeeds for `11111111-1111-4111-8111-111111111111`
- **AND** Codex tmux pane detection returns a single pane `%1902`
- **WHEN** the tool completes successfully
- **THEN** it returns `{ agent_id, team: 'default', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799' }`
- **AND** the caller's `agents` row is persisted with `delivery.kind='codex-appserver'`
- **AND** the caller's `agents` row is persisted with `tmux_pane_id='%1902'`

#### Scenario: explicit tmux_pane_id overrides pane detection

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead', thread_id: '11111111-1111-4111-8111-111111111111', tmux_pane_id: '%42', cwd: '/workspace/project' })`
- **AND** `thread/resume` succeeds for `11111111-1111-4111-8111-111111111111`
- **WHEN** the tool completes successfully
- **THEN** the caller's `agents` row is persisted with `tmux_pane_id='%42'`
- **AND** the tool does not require detector output to accept the pane value

#### Scenario: ambiguous pane detection does not block codex registration

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead', thread_id: '11111111-1111-4111-8111-111111111111', cwd: '/workspace/project' })`
- **AND** `thread/resume` succeeds for `11111111-1111-4111-8111-111111111111`
- **AND** Codex tmux pane detection returns `ambiguous_match`
- **WHEN** the tool completes successfully
- **THEN** it still returns `{ agent_id, team, thread_id: '11111111-1111-4111-8111-111111111111', ws_url }`
- **AND** the caller's `agents` row is persisted with `delivery.kind='codex-appserver'`
- **AND** the call does not fail with a tmux-related error

#### Scenario: re-registration preserves existing pane when no new pane is found

- **GIVEN** agent `(default, lead)` already exists with `tmux_pane_id='%42'`
- **AND** the caller invokes `register_codex_self({ name: 'lead', team: 'default', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** `thread/resume` succeeds for `11111111-1111-4111-8111-111111111111`
- **AND** Codex tmux pane detection returns `not_found`
- **WHEN** the tool completes successfully
- **THEN** the caller's `agents` row keeps `tmux_pane_id='%42'`
- **AND** the caller's `agents` row is updated with the newly confirmed `delivery.kind='codex-appserver'`

#### Scenario: register_codex_self requires explicit thread_id when resumable threads exist

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead' })`
- **AND** the default websocket endpoint reports resumable thread ids `['11111111-1111-4111-8111-111111111111']`
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'thread_id_required', detail: { ws_url: 'ws://127.0.0.1:8799', thread_ids: ['11111111-1111-4111-8111-111111111111'] } }`
- **AND** no `agents` row is inserted or updated for the caller

#### Scenario: register_codex_self returns no_loaded_threads

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead' })`
- **AND** the Codex app-server reports zero loaded threads
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'no_loaded_threads', detail: { ws_url: 'ws://127.0.0.1:8799' } }`

#### Scenario: register_codex_self returns codex_resume_failed for an explicit thread_id

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** the app-server returns a JSON-RPC error for `thread/resume`
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'codex_resume_failed', detail: { thread_id: '11111111-1111-4111-8111-111111111111', cause: ... } }`

#### Scenario: register_codex_self returns unsupported_client outside Codex

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **AND** the websocket endpoint is unreachable or does not implement the Codex protocol
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'unsupported_client', detail: { expected: 'codex', reason: ..., ws_url, cause? } }`
