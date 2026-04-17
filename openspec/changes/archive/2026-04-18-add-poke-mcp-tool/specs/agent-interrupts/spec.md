## ADDED Requirements

### Requirement: poke tool registration and input schema

The daemon SHALL register an MCP tool named `poke` that takes `{ target_agent_id: string, prompt: string }` and returns either `{ ok: true, pane_id: string, pane_tail_before: string, pane_tail_after: string }` on success or `{ error: string, detail?: string | object }` on failure. The tool MUST be listed in the MCP server's `list_tools` response exactly once.

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

### Requirement: Target without tmux_pane_id returns tmux_pane_not_set

If the target row's `tmux_pane_id` column is NULL or empty string, the daemon MUST return `{ error: 'tmux_pane_not_set' }`.

#### Scenario: Target never registered pane id

- **GIVEN** target `sess-B` is registered without `tmux_pane_id`
- **WHEN** caller `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'p' })`
- **THEN** the response is `{ error: 'tmux_pane_not_set' }`
- **AND** no tmux command is executed

### Requirement: Self-poke is rejected

If `target_agent_id` equals the caller's own `agent_id`, the daemon MUST return `{ error: 'self_poke_denied' }`.

#### Scenario: Caller pokes self

- **GIVEN** caller `sess-A` is registered
- **WHEN** `sess-A` calls `poke({ target_agent_id: 'sess-A', prompt: 'p' })`
- **THEN** the response is `{ error: 'self_poke_denied' }`
- **AND** no tmux command is executed

### Requirement: Cross-team poke is rejected

If the target's `team` does not equal the caller's `team`, the daemon MUST return `{ error: 'cross_team_denied' }`.

#### Scenario: Cross-team target

- **GIVEN** caller `sess-A` is in team `alpha` and target `sess-B` is in team `beta`
- **WHEN** `sess-A` calls `poke({ target_agent_id: 'sess-B', prompt: 'p' })`
- **THEN** the response is `{ error: 'cross_team_denied' }`
- **AND** no tmux command is executed

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
