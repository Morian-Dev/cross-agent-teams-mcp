## MODIFIED Requirements

### Requirement: poke tool registration and input schema

The daemon SHALL register an MCP tool named `poke` that takes `{ target_agent_id: string, prompt: string }` and returns one of the following on success:

- `{ ok: true, transport_used: 'claude-channel', channel_session_id: string }`
- `{ ok: true, transport_used: 'opencode-server', base_url: string, session_id: string }`
- `{ ok: true, transport_used: 'tmux-poke', pane_id: string, pane_tail_before: string, pane_tail_after: string }`

On failure it returns `{ error: string, detail?: string | object, transport_used?: 'tmux-poke' }`.  The tool MUST be listed in the MCP server's `list_tools` response exactly once.

#### Scenario: poke appears in list_tools

- **GIVEN** a running daemon with an initialized MCP session
- **WHEN** the client calls `tools/list`
- **THEN** the response contains a tool entry with `name === 'poke'`
- **AND** its `inputSchema` requires `target_agent_id` and `prompt`, both of type string

### Requirement: poke happy path delivers paste and returns before/after tails

When the caller and target are both registered agents in the same team, the target has `tmux_pane_id` set, tmux CLI is available, and no higher-priority transport succeeded for that poke call, the daemon SHALL (in order) capture the target pane's tail, load the `prompt` bytes into a scoped tmux buffer, paste-buffer that buffer into the target pane with bracketed paste, wait ~400ms, send the Enter key, wait ~400ms, and capture the pane's tail again.  The successful response MUST contain the target's `pane_id`, the pre-paste tail as `pane_tail_before`, and the post-Enter tail as `pane_tail_after`.  Each tail SHOULD cover approximately 8 lines of scrollback.

#### Scenario: Happy path returns before/after tails when tmux is selected

- **GIVEN** caller `sess-A` and target `sess-B` both registered in team `default`
- **AND** `sess-B` has `tmux_pane_id = '%42'` and the pane is live
- **AND** tmux CLI is available
- **AND** `sess-B` has no live Claude channel sink and no bound opencode session
- **WHEN** `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'hello' })`
- **THEN** the response has `ok === true`, `transport_used === 'tmux-poke'`, and `pane_id === '%42'`
- **AND** `pane_tail_before` is a non-empty string reflecting pane `%42` state before paste
- **AND** `pane_tail_after` is a non-empty string reflecting pane `%42` state after paste+Enter
- **AND** `pane_tail_after !== pane_tail_before` in the common case where the agent TUI redraws the input box

## REMOVED Requirements

### Requirement: Target without tmux_pane_id returns tmux_pane_not_set

**Reason**: `poke` no longer treats tmux as the only non-channel delivery path.  A target without `tmux_pane_id` may still be reachable through a bound opencode session, and the fully-unconfigured case now returns `no_transport_available`.

**Migration**: Callers that previously keyed on `tmux_pane_not_set` should instead handle `no_transport_available` for fully unbound targets, or the new opencode-specific errors when an opencode binding exists but delivery fails.

## ADDED Requirements

### Requirement: Target without any configured transport returns no_transport_available

If the target row has no live `channel_session_id` sink, no complete opencode binding, and no `tmux_pane_id`, the daemon MUST return `{ error: 'no_transport_available', detail: { channel_subscribed: false, opencode_bound: false, tmux_pane_set: false } }`.

#### Scenario: Target has no configured delivery route

- **GIVEN** target `sess-B` is registered with `channel_session_id=NULL`, `opencode_base_url=NULL`, `opencode_session_id=NULL`, and `tmux_pane_id=NULL`
- **WHEN** caller `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'p' })`
- **THEN** the response is `{ error: 'no_transport_available', detail: { channel_subscribed: false, opencode_bound: false, tmux_pane_set: false } }`
- **AND** no tmux command is executed

### Requirement: tmux unavailable returns tmux_unavailable only when tmux transport is selected

If the daemon cannot invoke `tmux` and a poke call has already fallen through higher-priority transports to the tmux path, the `poke` tool MUST return `{ error: 'tmux_unavailable', detail: <stderr or node error message>, transport_used: 'tmux-poke' }`.

#### Scenario: No tmux binary on PATH after channel and opencode are unavailable

- **GIVEN** a daemon launched on a host where `tmux` is not installed
- **AND** target `sess-B` has no live Claude channel sink and no bound opencode session
- **AND** `sess-B` has a non-null `tmux_pane_id`
- **WHEN** caller `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'p' })`
- **THEN** the response is `{ error: 'tmux_unavailable', detail: '<non-empty string>', transport_used: 'tmux-poke' }`

### Requirement: tmux pane dead returns pane_dead only when tmux transport is selected

If tmux returns an error that indicates the target pane no longer exists or is marked dead, and the poke call is already on the tmux path, the daemon MUST return `{ error: 'pane_dead', detail: <tmux stderr>, transport_used: 'tmux-poke' }`.

#### Scenario: Target pane was killed after registration and tmux path is selected

- **GIVEN** target `sess-B` was registered with `tmux_pane_id = '%42'`
- **AND** `sess-B` has no live Claude channel sink and no bound opencode session
- **AND** the user subsequently killed pane `%42` in tmux
- **WHEN** caller `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'p' })`
- **THEN** the response is `{ error: 'pane_dead', detail: <string containing 'find pane' or similar>, transport_used: 'tmux-poke' }`
