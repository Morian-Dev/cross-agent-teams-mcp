## MODIFIED Requirements

### Requirement: poke tool registration and input schema

The daemon SHALL register an MCP tool named `poke` that takes `{ target_agent_id: string, prompt: string }`.

On success, the tool SHALL return a transport-specific envelope:

- tmux success: `{ ok: true, transport_used: 'tmux-poke', pane_id: string, pane_tail_before: string, pane_tail_after: string }`
- Claude channel success: `{ ok: true, transport_used: 'claude-channel', channel_session_id: string }`
- Codex app-server success: `{ ok: true, transport_used: 'codex-appserver', thread_id: string }`

On failure, the tool SHALL return `{ error: string, detail?: string | object, transport_used?: string }`.

The tool MUST be listed in the MCP server's `list_tools` response exactly once.

#### Scenario: poke appears in list_tools

- **GIVEN** a running daemon with an initialized MCP session
- **WHEN** the client calls `tools/list`
- **THEN** the response contains a tool entry with `name === 'poke'`
- **AND** its `inputSchema` requires `target_agent_id` and `prompt`, both of type string

#### Scenario: Codex target returns codex-appserver success envelope

- **GIVEN** caller `sess-A` and target `sess-B` are registered in the same team
- **AND** `sess-B` has `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799'}`
- **WHEN** `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'hello' })`
- **THEN** the response is `{ ok: true, transport_used: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111' }`

### Requirement: Target without tmux_pane_id returns tmux_pane_not_set

If the target has no usable configured delivery transport and also has no `tmux_pane_id`, the daemon MUST return `{ error: 'no_transport_available', detail: { channel_subscribed: false, tmux_pane_set: false } }`.

This requirement covers the modern delivery abstraction surface where the target may have `delivery.kind='none'`, or `delivery.kind='claude-channel'` without an attached sink.  A target with `delivery.kind='codex-appserver'` does NOT require a tmux pane and MUST be routed through the Codex dispatcher instead.

#### Scenario: Target with no delivery transport returns no_transport_available

- **GIVEN** target `sess-B` is registered with `delivery={kind: 'none'}` and no `tmux_pane_id`
- **WHEN** caller `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'p' })`
- **THEN** the response is `{ error: 'no_transport_available', detail: { channel_subscribed: false, tmux_pane_set: false } }`

#### Scenario: Codex target with no tmux_pane_id still routes successfully

- **GIVEN** target `sess-B` is registered with `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799'}` and no `tmux_pane_id`
- **WHEN** caller `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'p' })`
- **THEN** the daemon does NOT return `no_transport_available`
- **AND** it routes through the Codex transport
