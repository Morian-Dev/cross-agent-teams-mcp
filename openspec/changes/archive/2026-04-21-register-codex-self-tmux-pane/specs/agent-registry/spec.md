## MODIFIED Requirements

### Requirement: register_codex_self autodetects and registers a Codex app-server delivery

The daemon SHALL expose a tool `register_codex_self` for Codex remote sessions.  The tool accepts human-facing identity fields such as `name`, `team`, and `role`, plus optional `ws_url`, `auth_token_ref`, `tmux_pane_id`, `cwd`, `tty`, and `title_contains`.  It SHALL:

1. Connect to the Codex app-server websocket, defaulting `ws_url` to `ws://127.0.0.1:8799` when not provided.
2. Initialize the Codex protocol.
3. Call `thread/loaded/list`.
4. Attempt `thread/resume` against the loaded thread ids.
5. If exactly one thread is resumable, register the caller as `delivery.kind='codex-appserver'` using that `thread_id`.
6. Persist a `tmux_pane_id` alongside the Codex delivery when either:
   - the caller supplied a usable `tmux_pane_id`, or
   - the caller omitted `tmux_pane_id` and the tool can derive a single Codex tmux pane via the existing Codex pane-detection logic, optionally narrowed by `cwd`, `tty`, or `title_contains`.
7. Treat tmux pane capture as best-effort.  If pane detection returns `not_found`, `ambiguous_match`, or `tmux_unavailable`, the tool MUST still succeed with the Codex delivery registration and MUST NOT fail the overall call solely because tmux pane discovery was incomplete.

When a usable `tmux_pane_id` is supplied directly, the tool MUST prefer that explicit value and MUST NOT replace it with detector output.  When no new usable pane id is available, the persisted `tmux_pane_id` follows the normal registration semantics: omit on first insert yields `NULL`, omit on re-registration preserves the existing value.

The tool is Codex-only.  If the websocket endpoint is unreachable or does not speak the expected Codex protocol, the tool SHALL return `{error: 'unsupported_client', detail: { expected: 'codex', reason: ..., ws_url, cause? }}` rather than guessing.

#### Scenario: register_codex_self registers the single resumable thread and detected pane

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead', team: 'default', role: 'worker', cwd: '/workspace/project' })`
- **AND** the default websocket endpoint has exactly one resumable loaded thread
- **AND** Codex tmux pane detection returns a single pane `%1902`
- **WHEN** the tool completes successfully
- **THEN** it returns `{ agent_id, team: 'default', thread_id, ws_url: 'ws://127.0.0.1:8799' }`
- **AND** the caller's `agents` row is persisted with `delivery.kind='codex-appserver'`
- **AND** the caller's `agents` row is persisted with `tmux_pane_id='%1902'`

#### Scenario: explicit tmux_pane_id overrides pane detection

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead', tmux_pane_id: '%42', cwd: '/workspace/project' })`
- **AND** the default websocket endpoint has exactly one resumable loaded thread
- **WHEN** the tool completes successfully
- **THEN** the caller's `agents` row is persisted with `tmux_pane_id='%42'`
- **AND** the tool does not require detector output to accept the pane value

#### Scenario: ambiguous pane detection does not block codex registration

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead', cwd: '/workspace/project' })`
- **AND** the default websocket endpoint has exactly one resumable loaded thread
- **AND** Codex tmux pane detection returns `ambiguous_match`
- **WHEN** the tool completes successfully
- **THEN** it still returns `{ agent_id, team, thread_id, ws_url }`
- **AND** the caller's `agents` row is persisted with `delivery.kind='codex-appserver'`
- **AND** the call does not fail with a tmux-related error

#### Scenario: re-registration preserves existing pane when no new pane is found

- **GIVEN** agent `(default, lead)` already exists with `tmux_pane_id='%42'`
- **AND** the caller invokes `register_codex_self({ name: 'lead', team: 'default' })`
- **AND** the default websocket endpoint has exactly one resumable loaded thread
- **AND** Codex tmux pane detection returns `not_found`
- **WHEN** the tool completes successfully
- **THEN** the caller's `agents` row keeps `tmux_pane_id='%42'`
- **AND** the caller's `agents` row is updated with the newly confirmed `delivery.kind='codex-appserver'`

#### Scenario: register_codex_self returns no_loaded_threads

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead' })`
- **AND** the Codex app-server reports zero loaded threads
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'no_loaded_threads', detail: { ws_url: 'ws://127.0.0.1:8799' } }`

#### Scenario: register_codex_self returns ambiguous_loaded_threads

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead' })`
- **AND** more than one loaded thread is resumable
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'ambiguous_loaded_threads', detail: { thread_ids: [...] } }`

#### Scenario: register_codex_self returns unsupported_client outside Codex

- **GIVEN** the caller invokes `register_codex_self({ name: 'lead' })`
- **AND** the websocket endpoint is unreachable or does not implement the Codex protocol
- **WHEN** the tool completes
- **THEN** it returns `{ error: 'unsupported_client', detail: { expected: 'codex', reason: ..., ws_url, cause? } }`
