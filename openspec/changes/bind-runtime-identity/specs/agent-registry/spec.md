## MODIFIED Requirements

### Requirement: Tmux pane id persistence

The daemon MUST NOT auto-detect and persist `tmux_pane_id` during `register_agent`.  Instead, tmux pane binding is written only by explicit runtime-binding paths after registration.  `register_agent` may still succeed with `tmux_pane_id = NULL`.

#### Scenario: register_agent succeeds without auto-detecting a pane

- **GIVEN** a caller invokes `register_agent({ model, name: 'alice' })`
- **WHEN** the daemon processes the registration
- **THEN** the call succeeds
- **AND** the row may still have `tmux_pane_id = NULL`
- **AND** the success hint directs the caller to `bind_runtime_identity(...)`

### Requirement: bind_runtime_identity verifies and persists tmux runtime identity

The daemon SHALL expose `bind_runtime_identity({ agent, ui_pid?, ui_tty?, tmux_pane_id?, process_pattern? })` for registered callers.

The tool SHALL require one of:

1. `ui_pid`
2. `ui_tty` together with `tmux_pane_id`

If `ui_pid` is supplied, the daemon SHALL:

1. Read the process tty and command from the local host.
2. Verify the command matches the declared agent kind.
3. Resolve the tty to a tmux pane.
4. Persist the verified `tmux_pane_id`, `runtime_ui_pid`, `runtime_tty`, `runtime_verification_mode`, and `runtime_bound_at`.

If `ui_tty + tmux_pane_id` are supplied, the daemon SHALL:

1. Verify the pane exists and its tty equals `ui_tty`
2. Verify that tty hosts a process matching the declared agent kind
3. Persist the same runtime metadata, with `runtime_ui_pid = NULL`

#### Scenario: bind_runtime_identity succeeds via ui_pid

- **GIVEN** caller `alice` is already registered
- **AND** `ui_pid` belongs to a Codex UI process whose tty maps to pane `%1902`
- **WHEN** `alice` invokes `bind_runtime_identity({ agent: 'codex', ui_pid: 81979 })`
- **THEN** the response is `{ ok: true, tmux_pane_id: '%1902', verification_mode: 'verified_pid_tty_pane', tty: 'ttys026', ui_pid: 81979 }`
- **AND** the caller row persists `tmux_pane_id='%1902'`

#### Scenario: bind_runtime_identity succeeds via ui_tty plus pane id

- **GIVEN** caller `alice` is already registered
- **AND** pane `%1916` exists with tty `ttys020`
- **AND** tty `ttys020` hosts a matching Claude process
- **WHEN** `alice` invokes `bind_runtime_identity({ agent: 'claude-code', ui_tty: '/dev/ttys020', tmux_pane_id: '%1916' })`
- **THEN** the response is `{ ok: true, tmux_pane_id: '%1916', verification_mode: 'verified_tty_pane', tty: 'ttys020' }`
- **AND** the caller row persists `tmux_pane_id='%1916'`
