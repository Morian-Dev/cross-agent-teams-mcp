## MODIFIED Requirements

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
