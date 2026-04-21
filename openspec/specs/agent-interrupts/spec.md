# agent-interrupts Specification

## Purpose

Cross-session agent wake-up and interrupt semantics. Currently ships the `poke` MCP tool; future additions may include cancel_agent / stop_streaming / reset_context.
## Requirements
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

### Requirement: poke happy path delivers paste and returns before/after tails

When the caller and target are both registered agents in the same team, the target has `tmux_pane_id` set, and tmux CLI is available, the daemon SHALL (in order) capture the target pane's tail, load the `prompt` bytes into a scoped tmux buffer, paste-buffer that buffer into the target pane with bracketed paste, wait ~400ms, send the Enter key, wait ~400ms, and capture the pane's tail again. The successful response MUST contain the target's `pane_id`, the pre-paste tail as `pane_tail_before`, and the post-Enter tail as `pane_tail_after`. Each tail SHOULD cover approximately 8 lines of scrollback.

#### Scenario: Happy path returns before/after tails

- **GIVEN** caller `sess-A` and target `sess-B` both registered in team `default`
- **AND** `sess-B` has `tmux_pane_id = '%42'` and the pane is live
- **AND** tmux CLI is available
- **WHEN** `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'hello' })`
- **THEN** the response has `ok === true`, `pane_id === '%42'`
- **AND** `pane_tail_before` is a non-empty string reflecting pane `%42` state before paste
- **AND** `pane_tail_after` is a non-empty string reflecting pane `%42` state after paste+Enter
- **AND** `pane_tail_after !== pane_tail_before` in the common case where the agent TUI redraws the input box

#### Scenario: Daemon issues tmux commands without shell

- **GIVEN** a poke in progress
- **WHEN** the daemon invokes tmux for capture-pane / load-buffer / paste-buffer / send-keys
- **THEN** it uses `child_process.execFile('tmux', [<args>])`, not `child_process.exec` with a shell string
- **AND** the `prompt` bytes are delivered to `load-buffer` via stdin, not via a shell argument

### Requirement: Caller must be a registered agent

The `poke` tool MUST reject any invocation from an MCP session that has not called `register_agent`. The daemon MUST return `{ error: 'unknown_agent' }` without attempting any tmux action.

#### Scenario: Unregistered session rejected with unknown_agent

- **GIVEN** an MCP session `sess-X` that has not registered
- **WHEN** it calls `poke({ target_agent_id: 'anything', prompt: 'p' })`
- **THEN** the response is `{ error: 'unknown_agent' }`
- **AND** no tmux command is executed

### Requirement: Unknown target_agent_id returns unknown_target

If the `target_agent_id` does not correspond to any row in the `agents` table, the daemon MUST return `{ error: 'unknown_target' }`.

#### Scenario: Target not in agents table

- **GIVEN** caller `sess-A` is registered
- **AND** no row in `agents` table has `agent_id = 'ghost-xyz'`
- **WHEN** caller calls `poke({ target_agent_id: 'ghost-xyz', prompt: 'p' })`
- **THEN** the response is `{ error: 'unknown_target' }`
- **AND** no tmux command is executed

### Requirement: Target without any available delivery transport returns no_transport_available

If the target has no usable configured delivery transport and also has no `tmux_pane_id`, the daemon MUST return `{ error: 'no_transport_available', detail: { channel_subscribed: false, tmux_pane_set: false } }`.

#### Scenario: Target with delivery kind none and no pane returns no_transport_available

- **GIVEN** target `sess-B` is registered with `delivery={kind: 'none'}` and no `tmux_pane_id`
- **WHEN** caller `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'p' })`
- **THEN** the response is `{ error: 'no_transport_available', detail: { channel_subscribed: false, tmux_pane_set: false } }`
- **AND** no tmux command is executed

#### Scenario: Target with codex-appserver delivery and no pane still routes successfully

- **GIVEN** target `sess-B` is registered with `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799'}` and no `tmux_pane_id`
- **WHEN** caller `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'p' })`
- **THEN** the daemon routes through the Codex transport instead of returning `no_transport_available`

### Requirement: Self-poke is rejected

If `target_agent_id` equals the caller's own `agent_id`, the daemon MUST return `{ error: 'self_poke_denied' }`. The judgment is keyed strictly on the canonical `agent_id` (the `agents` table primary key); no other attribute (team, role, name, tmux_pane_id, channel_session_id, MCP session id, or process pid) MAY trigger this error on its own.

#### Scenario: Caller pokes self

- **GIVEN** caller `sess-A` is registered
- **WHEN** `sess-A` calls `poke({ target_agent_id: 'sess-A', prompt: 'p' })`
- **THEN** the response is `{ error: 'self_poke_denied' }`
- **AND** no tmux command is executed

#### Scenario: Distinct agents are never treated as self-poke

- **GIVEN** caller agent `A` (`agent_id='id-A'`, `team='default'`, `name='alice'`, `tmux_pane_id='%42'`)
- **AND** target agent `B` (`agent_id='id-B'`, `team='default'`, `name='bob'`, `tmux_pane_id='%42'`)
- **AND** `id-A !== id-B`
- **WHEN** `A` calls `poke({ target_agent_id: 'id-B', prompt: 'p' })`
- **THEN** the response is NOT `{ error: 'self_poke_denied' }`
- **AND** the tmux delivery pipeline is allowed to proceed (subject to other guards such as `tmux_pane_not_set`, `tmux_unavailable`, `pane_dead`)
- **AND** the equality of any non-`agent_id` attribute (here both share `tmux_pane_id='%42'` and `team='default'`) MUST NOT short-circuit to `self_poke_denied`

### Requirement: Cross-team poke via the MCP tool is rejected

When a caller invokes the `poke` MCP tool directly AND the target's `team` does not equal the caller's `team`, the daemon SHALL return `{ error: 'cross_team_denied' }` without executing any tmux command.

This constraint applies only to **direct MCP tool calls**. Internal auto-poke dispatched by `send_message`, `broadcast`, or `broadcast_to_role` bypasses this check — see Requirement "Internal auto-poke bypasses the cross-team check".

#### Scenario: Cross-team target via MCP tool

- **GIVEN** caller `sess-A` is in team `alpha` and target `sess-B` is in team `beta`
- **WHEN** `sess-A` invokes the `poke` MCP tool with `{ target_agent_id: 'sess-B', prompt: 'p' }`
- **THEN** the response is `{ error: 'cross_team_denied' }`
- **AND** no tmux command is executed

### Requirement: Internal auto-poke bypasses the cross-team check

When the daemon's internal auto-poke implementation (`createAutoPokeImpl`, invoked by `send_message` / `broadcast` / `broadcast_to_role` fan-out paths) calls `poke()` to inject a wake-up hint, the caller-team-vs-target-team equality check MUST be bypassed, even when the caller and target belong to different teams.

The prompt injected via this path is fixed to the format `新邮件 from {sender_identifier}, 请调 get_inbox 查看` (built by `buildAutoPokeHint`). The bypass is permitted ONLY because the prompt format is constant and contains no message-body substring; any future path that wishes to bypass the cross-team check MUST also restrict its prompt to a constrained, non-leaky format.

The MCP `poke` tool input schema MUST NOT expose any parameter that controls this bypass; the bypass is strictly internal to the daemon's process.

#### Scenario: Cross-team send_message triggers a successful auto-poke

- **GIVEN** agent `sess-A` is registered in team `alpha` with `tmux_pane_id='%pA'`
- **AND** agent `sess-B` is registered in team `beta` with `tmux_pane_id='%pB'` and its pane is idle
- **AND** `POKE_QUIET_MS=50` for test speed
- **WHEN** `sess-A` invokes `send_message({to_agent_id:'sess-B', to_team:'beta', body:'hi'})`
- **THEN** the response has `poked: true`
- **AND** `poke_skip_reasons` does NOT contain `{agent_id:'sess-B', reason:'guard_failed'}`
- **AND** `%pB` has received a `paste-buffer` + `send-keys Enter` sequence carrying the hint `新邮件 from <A's display name or agent_id[:8]>, 请调 get_inbox 查看`

#### Scenario: Direct MCP poke call with the same cross-team pair still denied

- **GIVEN** agent `sess-A` in team `alpha`, agent `sess-B` in team `beta`, both with valid panes
- **WHEN** `sess-A` invokes the `poke` MCP tool with `{ target_agent_id: 'sess-B', prompt: 'p' }`
- **THEN** the response is `{ error: 'cross_team_denied' }`
- **AND** no tmux command is executed
- **AND** the fact that internal auto-poke is permitted for the same pair has no bearing on this direct call

### Requirement: Prompt exceeding 8 KB is rejected

If `Buffer.byteLength(prompt, 'utf8')` is greater than 8192, the daemon MUST return `{ error: 'prompt_too_long', detail: { max: 8192, got: <N> } }` where `<N>` is the actual byte length.

#### Scenario: 10 KB prompt rejected before any tmux action

- **GIVEN** caller `sess-A` and target `sess-B` both valid
- **AND** `prompt` is 10240 bytes of ASCII
- **WHEN** caller calls `poke` with this prompt
- **THEN** the response is `{ error: 'prompt_too_long', detail: { max: 8192, got: 10240 } }`
- **AND** no tmux command is executed

### Requirement: tmux unavailable returns tmux_unavailable

If the daemon cannot invoke `tmux` (e.g. `tmux -V` returns ENOENT or non-zero), the `poke` tool MUST return `{ error: 'tmux_unavailable', detail: <stderr or node error message> }`. The daemon MAY cache the availability probe result across invocations.

#### Scenario: No tmux binary on PATH

- **GIVEN** a daemon launched on a host where `tmux` is not installed
- **WHEN** any caller calls `poke({ ... })` with otherwise valid input
- **THEN** the response is `{ error: 'tmux_unavailable', detail: '<non-empty string>' }`

### Requirement: tmux pane dead returns pane_dead

If tmux returns an error that indicates the target pane no longer exists or is marked dead (`can't find pane` in stderr or `#{pane_dead} == 1`), the daemon MUST return `{ error: 'pane_dead', detail: <tmux stderr> }`.

#### Scenario: Target pane was killed after registration

- **GIVEN** target `sess-B` was registered with `tmux_pane_id = '%42'`
- **AND** the user subsequently killed pane `%42` in tmux
- **WHEN** caller `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'p' })`
- **THEN** the response is `{ error: 'pane_dead', detail: <string containing 'find pane' or similar> }`

### Requirement: Other tmux CLI failures return tmux_cmd_failed

For any other tmux CLI error not classified as `tmux_unavailable` or `pane_dead`, the daemon MUST return `{ error: 'tmux_cmd_failed', detail: { stage: 'capture_before' | 'load_buffer' | 'paste_buffer' | 'send_keys' | 'capture_after', stderr: string } }`.

#### Scenario: load-buffer fails unexpectedly

- **GIVEN** a poke call reaches the `load-buffer` stage
- **AND** tmux returns a non-zero exit with stderr `<unexpected error>`
- **WHEN** the daemon processes this failure
- **THEN** the response is `{ error: 'tmux_cmd_failed', detail: { stage: 'load_buffer', stderr: '<unexpected error>' } }`
