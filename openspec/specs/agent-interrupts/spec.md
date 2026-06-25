# agent-interrupts Specification

## Purpose

Cross-session agent wake-up and interrupt semantics. Currently ships the `poke` MCP tool; future additions may include cancel_agent / stop_streaming / reset_context.
## Requirements
### Requirement: poke tool registration and input schema

The daemon SHALL NOT register a public MCP tool named `poke` for ordinary agent sessions.  Public MCP clients MUST NOT be able to call `poke({ target_agent_id, prompt })` through the tool registry, and `poke` MUST NOT appear in the MCP server's `list_tools` response.

The daemon MAY keep internal functions and transport-specific envelopes for wake delivery, but those functions are not part of the public MCP tool schema.

#### Scenario: poke does not appear in list_tools

- **GIVEN** a running daemon with an initialized MCP session
- **WHEN** the client calls `tools/list`
- **THEN** the response contains no tool entry with `name === 'poke'`

#### Scenario: Direct poke call is unavailable

- **GIVEN** a running daemon with an initialized MCP session
- **WHEN** the client attempts to call a tool named `poke`
- **THEN** the server rejects the call because no such public tool is registered
- **AND** no wake delivery transport is invoked

### Requirement: poke happy path delivers paste and returns before/after tails

When the caller and target are both registered agents in the same team, the target has `tmux_pane_id` set, tmux CLI is available, and no higher-priority transport succeeded for that poke call, the daemon SHALL run the tmux quiet-guard before pasting, UNLESS the internal `skipGuard` flag is set on the poke call:

1. Capture the target pane's tail.
2. Wait `POKE_QUIET_MS` milliseconds (default 2000, overridable via the `POKE_QUIET_MS` environment variable, positive integer).
3. Re-capture the pane tail and compare it (string-equal or equivalent hash) to the first capture.
4. If the two captures differ (the pane has activity), the daemon MUST NOT paste and MUST return `{error: 'guard_failed', transport_used: 'tmux-poke'}`.

When the captures match (idle pane) OR `skipGuard` is set, the daemon SHALL (in order) capture the target pane's tail, load the `prompt` bytes into a scoped tmux buffer, paste-buffer that buffer into the target pane with bracketed paste, wait ~400ms, send the Enter key, wait ~400ms, and capture the pane's tail again.  The successful response MUST contain the target's `pane_id`, the pre-paste tail as `pane_tail_before`, and the post-Enter tail as `pane_tail_after`.  Each tail SHOULD cover approximately 8 lines of scrollback.

The `skipGuard` flag is internal only — it is set by the auto-poke retry tick (which has already run its own quiet-guard) to avoid double-guarding, and is never exposed on any public MCP tool.

#### Scenario: Happy path returns before/after tails

- **GIVEN** caller `sess-A` and target `sess-B` both registered in team `default`
- **AND** `sess-B` has `tmux_pane_id = '%42'` and the pane is live
- **AND** tmux CLI is available
- **AND** `%42` stays idle through the quiet-guard window (`POKE_QUIET_MS` small for test speed), so the guard passes
- **WHEN** `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'hello' })`
- **THEN** the response has `ok === true`, `pane_id === '%42'`
- **AND** `pane_tail_before` is a non-empty string reflecting pane `%42` state before paste
- **AND** `pane_tail_after` is a non-empty string reflecting pane `%42` state after paste+Enter
- **AND** `pane_tail_after !== pane_tail_before` in the common case where the agent TUI redraws the input box

#### Scenario: Happy path returns before/after tails when tmux is selected

- **GIVEN** caller `sess-A` and target `sess-B` both registered in team `default`
- **AND** `sess-B` has `tmux_pane_id = '%42'` and the pane is live
- **AND** tmux CLI is available
- **AND** `sess-B` has no live Claude channel sink and no bound opencode session
- **AND** `%42` stays idle through the quiet-guard window (`POKE_QUIET_MS` small for test speed), so the guard passes
- **WHEN** `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'hello' })`
- **THEN** the response has `ok === true`, `transport_used === 'tmux-poke'`, and `pane_id === '%42'`
- **AND** `pane_tail_before` is a non-empty string reflecting pane `%42` state before paste
- **AND** `pane_tail_after` is a non-empty string reflecting pane `%42` state after paste+Enter
- **AND** `pane_tail_after !== pane_tail_before` in the common case where the agent TUI redraws the input box

#### Scenario: Active pane during quiet-guard skips paste

- **GIVEN** caller `sess-A` and target `sess-B` in team `default`, `sess-B` has `tmux_pane_id = '%42'`, tmux available
- **AND** `sess-B` has no live Claude channel sink and no bound opencode session
- **AND** `%42` is actively redrawing during the quiet-guard window (`POKE_QUIET_MS` small for test speed)
- **WHEN** `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'hello' })`
- **THEN** the response is `{error: 'guard_failed', transport_used: 'tmux-poke'}`
- **AND** no `load-buffer` / `paste-buffer` / `send-keys` command is issued for `%42`

#### Scenario: skipGuard bypasses the quiet-guard and pastes

- **GIVEN** the same active-pane setup, but the poke is invoked with the internal `skipGuard` flag set (as the retry tick does)
- **WHEN** the daemon dispatches the poke to `%42`
- **THEN** the daemon does NOT run the quiet-guard for this call
- **AND** it proceeds directly to load-buffer + paste-buffer + Enter on `%42`
- **AND** the response has `ok === true`, `transport_used === 'tmux-poke'`, `pane_id === '%42'`

#### Scenario: Daemon issues tmux commands without shell

- **GIVEN** a poke in progress
- **WHEN** the daemon invokes tmux for capture-pane / load-buffer / paste-buffer / send-keys
- **THEN** it uses `child_process.execFile('tmux', [<args>])`, not `child_process.exec` with a shell string
- **AND** the `prompt` bytes are delivered to `load-buffer` via stdin, not via a shell argument

### Requirement: Target without any available delivery transport returns no_transport_available

If the target has no usable configured delivery transport — no live `channel_session_id` sink, no complete opencode binding, and no `tmux_pane_id` — the daemon MUST return `{ error: 'no_transport_available', detail: { channel_subscribed: false, opencode_bound: false, tmux_pane_set: false } }`.

This requirement covers the modern delivery abstraction surface where the target may have `delivery.kind='none'`, or `delivery.kind='claude-channel'` without an attached sink, and also has neither a bound opencode session nor a tmux pane.  A target with `delivery.kind='codex-appserver'` does NOT require a tmux pane and MUST be routed through the Codex dispatcher instead.

#### Scenario: Target with no delivery transport returns no_transport_available

- **GIVEN** target `sess-B` is registered with `delivery={kind: 'none'}`, `opencode_base_url=NULL`, `opencode_session_id=NULL`, and no `tmux_pane_id`
- **WHEN** caller `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'p' })`
- **THEN** the response is `{ error: 'no_transport_available', detail: { channel_subscribed: false, opencode_bound: false, tmux_pane_set: false } }`
- **AND** no tmux command is executed

#### Scenario: Codex target with no tmux_pane_id still routes successfully

- **GIVEN** target `sess-B` is registered with `delivery={kind: 'codex-appserver', thread_id: '11111111-1111-4111-8111-111111111111', ws_url: 'ws://127.0.0.1:8799'}` and no `tmux_pane_id`
- **WHEN** caller `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'p' })`
- **THEN** the daemon does NOT return `no_transport_available`
- **AND** it routes through the Codex transport

### Requirement: Internal auto-poke bypasses the cross-team check

When the daemon's internal auto-poke implementation (`createAutoPokeImpl`, invoked by `send_message` / `broadcast` / `broadcast_to_role` fan-out paths) calls the internal wake delivery primitive to inject a wake-up hint, the caller-team-vs-target-team equality check MUST be bypassed, even when the caller and target belong to different teams.

The prompt injected via this path is fixed to the format `新邮件 from {sender_identifier}, 请调 get_inbox 查看` (built by `buildAutoPokeHint`).  The bypass is permitted ONLY because the prompt format is constant and contains no message-body substring; any future internal path that wishes to bypass the cross-team check MUST also restrict its prompt to a constrained, non-leaky format.

No public MCP tool input schema may expose any parameter that controls this bypass; the bypass is strictly internal to the daemon's process.

#### Scenario: Cross-team send_message triggers a successful auto-poke

- **GIVEN** agent `sess-A` is registered in team `alpha` with `tmux_pane_id='%pA'`
- **AND** agent with `name='bob'` is registered in team `beta` with `tmux_pane_id='%pB'` and its pane is idle
- **AND** `POKE_QUIET_MS=50` for test speed
- **WHEN** `sess-A` invokes `send_message({to_agent_name:'bob', to_team:'beta', body:'hi'})`
- **THEN** the response has `poked: true`
- **AND** `poke_skip_reasons` does NOT contain `{agent_id:<bob.uuid>, reason:'guard_failed'}`
- **AND** `%pB` has received a `paste-buffer` + `send-keys Enter` sequence carrying the hint `新邮件 from <A's display name or agent_id[:8]>, 请调 get_inbox 查看`

#### Scenario: Direct MCP poke is not the bypass path

- **GIVEN** agent `sess-A` in team `alpha`, agent `sess-B` in team `beta`, both with valid panes
- **WHEN** `sess-A` attempts to invoke a public MCP tool named `poke`
- **THEN** the call is rejected because no such public tool is registered
- **AND** the internal cross-team auto-poke bypass has no bearing on that direct call

### Requirement: Prompt exceeding 8 KB is rejected

If `Buffer.byteLength(prompt, 'utf8')` is greater than 8192, the daemon MUST return `{ error: 'prompt_too_long', detail: { max: 8192, got: <N> } }` where `<N>` is the actual byte length.

#### Scenario: 10 KB prompt rejected before any tmux action

- **GIVEN** caller `sess-A` and target `sess-B` both valid
- **AND** `prompt` is 10240 bytes of ASCII
- **WHEN** caller calls `poke` with this prompt
- **THEN** the response is `{ error: 'prompt_too_long', detail: { max: 8192, got: 10240 } }`
- **AND** no tmux command is executed

### Requirement: tmux unavailable returns tmux_unavailable

If the daemon cannot invoke `tmux` (e.g. `tmux -V` returns ENOENT or non-zero) and a poke call has already fallen through higher-priority transports to the tmux path, the `poke` tool MUST return `{ error: 'tmux_unavailable', detail: <stderr or node error message>, transport_used: 'tmux-poke' }`.  The daemon MAY cache the availability probe result across invocations.

#### Scenario: No tmux binary on PATH

- **GIVEN** a daemon launched on a host where `tmux` is not installed
- **AND** target `sess-B` has no live Claude channel sink and no bound opencode session
- **AND** `sess-B` has a non-null `tmux_pane_id`
- **WHEN** caller `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'p' })`
- **THEN** the response is `{ error: 'tmux_unavailable', detail: '<non-empty string>', transport_used: 'tmux-poke' }`

### Requirement: tmux pane dead returns pane_dead

If tmux returns an error that indicates the target pane no longer exists or is marked dead (`can't find pane` in stderr or `#{pane_dead} == 1`), and the poke call is already on the tmux path, the daemon MUST return `{ error: 'pane_dead', detail: <tmux stderr>, transport_used: 'tmux-poke' }`.

#### Scenario: Target pane was killed after registration

- **GIVEN** target `sess-B` was registered with `tmux_pane_id = '%42'`
- **AND** `sess-B` has no live Claude channel sink and no bound opencode session
- **AND** the user subsequently killed pane `%42` in tmux
- **WHEN** caller `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'p' })`
- **THEN** the response is `{ error: 'pane_dead', detail: <string containing 'find pane' or similar>, transport_used: 'tmux-poke' }`

### Requirement: Other tmux CLI failures return tmux_cmd_failed

For any other tmux CLI error not classified as `tmux_unavailable` or `pane_dead`, the daemon MUST return `{ error: 'tmux_cmd_failed', detail: { stage: 'capture_before' | 'load_buffer' | 'paste_buffer' | 'send_keys' | 'capture_after', stderr: string } }`.

#### Scenario: load-buffer fails unexpectedly

- **GIVEN** a poke call reaches the `load-buffer` stage
- **AND** tmux returns a non-zero exit with stderr `<unexpected error>`
- **WHEN** the daemon processes this failure
- **THEN** the response is `{ error: 'tmux_cmd_failed', detail: { stage: 'load_buffer', stderr: '<unexpected error>' } }`

### Requirement: Internal wake delivery primitive remains daemon-only
The daemon SHALL keep an internal wake delivery primitive that can deliver the fixed auto-poke hint through the configured transport stack, but it MUST NOT expose that primitive as a public MCP tool for ordinary agents.  Internal callers include `send_message`, `broadcast`, `broadcast_to_role`, and retry ticks.

#### Scenario: Auto-poke can still call the internal primitive
- **GIVEN** agent A sends a message to agent B and B has an idle delivery transport
- **WHEN** the auto-poke path runs inside the daemon
- **THEN** the daemon delivers the fixed wake hint to B
- **AND** no public `poke` tool is required for that delivery

#### Scenario: Public tools do not include poke
- **GIVEN** a registered agent MCP session
- **WHEN** the client calls `tools/list`
- **THEN** the response MUST NOT contain a tool named `poke`
