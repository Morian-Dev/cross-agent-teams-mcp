## MODIFIED Requirements

### Requirement: register_agent registers Codex delivery without implicit tmux binding

`register_agent({ client: 'codex', ... })` SHALL register Codex app-server delivery metadata, but it MUST NOT auto-detect or write `tmux_pane_id`.

If the caller wants tmux-based wake-up as a separate fallback, it MUST invoke `bind_runtime_identity(...)` after registration.

#### Scenario: register_agent succeeds with no pane binding

- **GIVEN** the caller invokes `register_agent({ client: 'codex', name: 'lead', model: 'gpt-5', thread_id: '11111111-1111-4111-8111-111111111111' })`
- **WHEN** the websocket handshake and `thread/resume` succeed
- **THEN** the response is `{ agent_id, team, thread_id, ws_url }`
- **AND** the caller row persists `delivery.kind='codex-appserver'`
- **AND** the caller row's `tmux_pane_id` remains unchanged, or `NULL` when no earlier runtime binding exists
