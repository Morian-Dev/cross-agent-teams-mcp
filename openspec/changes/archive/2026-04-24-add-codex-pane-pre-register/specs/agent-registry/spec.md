## ADDED Requirements

### Requirement: pre_register_codex_pane tool records pending tmux pane claim

The daemon SHALL expose an MCP tool `pre_register_codex_pane` that accepts `pane_id` (string, tmux pane identifier such as `%1972`), `xats_agent_id` (non-empty string, matches the UUID the launcher will place on the `codex --remote` command line via `-c xats.agent_id="<uuid>"`), and optional `ttl_seconds` (positive integer, default `120`, capped at `600`).  On success it SHALL persist a pending pre-registration row keyed by `pane_id` and return `{ ok: true, expires_at: <ISO8601> }`.  If `pane_id` or `xats_agent_id` is missing or empty, the tool SHALL return `{ error: "invalid_arguments", detail: <message> }` without writing any state.

#### Scenario: Launcher pre-registers a pane successfully
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"4EF01740-DBAC-4F39-BD94-64A058815856"})`
- **THEN** the daemon writes a pending pre-reg row for `%1972` with the given UUID and a `ttl_seconds=120` default expiry
- **AND** returns `{ ok: true, expires_at: <now + 120s> }`

#### Scenario: Missing pane_id is rejected
- **WHEN** the launcher calls `pre_register_codex_pane({xats_agent_id:"abc"})` without `pane_id`
- **THEN** the tool returns `{ error: "invalid_arguments", detail: <message mentioning pane_id> }`
- **AND** no state is written

#### Scenario: Empty xats_agent_id is rejected
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%10", xats_agent_id:""})`
- **THEN** the tool returns `{ error: "invalid_arguments", detail: <message mentioning xats_agent_id> }`
- **AND** no state is written

#### Scenario: ttl_seconds is capped at 600
- **WHEN** the launcher calls `pre_register_codex_pane({pane_id:"%10", xats_agent_id:"uuid", ttl_seconds:9999})`
- **THEN** the daemon stores the row with `expires_at = now + 600s`
- **AND** the returned `expires_at` reflects the capped value

### Requirement: pre_register_codex_pane overwrites existing entry for same pane

When a pre-reg for the same `pane_id` already exists, the new call SHALL replace the stored `xats_agent_id` and `expires_at` atomically.  The previous row SHALL NOT leak to subsequent register calls.

#### Scenario: Re-launching in the same pane overwrites
- **WHEN** pane `%1972` has a pending pre-reg with `xats_agent_id=A`
- **AND** the launcher calls `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"B"})`
- **THEN** the row for `%1972` now stores `xats_agent_id=B` and a fresh `expires_at`
- **AND** any subsequent `register_agent` match uses `B`, never `A`

### Requirement: Expired pending pre-regs are ignored and garbage-collected

A pre-reg row whose `expires_at` is in the past SHALL NOT match any `register_agent` call, even if `pane_id` and argv UUID align.  The daemon SHALL remove expired rows opportunistically (at minimum: on every `pre_register_codex_pane` write and on every codex `register_agent` consumption attempt).

#### Scenario: Expired pre-reg does not match
- **WHEN** a pre-reg for pane `%1972` with UUID `A` was created with `ttl_seconds=60`
- **AND** 120 seconds have elapsed
- **AND** a codex `register_agent` call arrives while the UI in pane `%1972` still has `xats.agent_id="A"` on its argv
- **THEN** the daemon does not auto-bind via the expired pre-reg
- **AND** registration proceeds with the normal no-pane hint fallback

#### Scenario: Expired rows are removed on next write
- **WHEN** pane `%1000` has an expired pre-reg row
- **AND** any client calls `pre_register_codex_pane({pane_id:"%2000", xats_agent_id:"x"})`
- **THEN** the expired row for `%1000` is deleted as part of the write
- **AND** only the new row for `%2000` remains

### Requirement: register_agent auto-binds codex pane via pending pre-reg

When `register_agent` is called with `client="codex"`, no `ui_pid`, no `tmux_pane_id`, and no explicit `delivery`, the daemon SHALL scan active pending pre-regs and select the unique row whose `pane_id` maps (via tmux `list-panes`) to a tty hosting a `codex --remote` process whose full argv contains `xats.agent_id="<stored uuid>"` (the outer double-quotes are the ones codex writes when the launcher passes `-c xats.agent_id="\"$uuid\""`).  On a unique match the daemon SHALL:

1. Extract the matched UI process pid from the pane's process table
2. Run the existing `bind_runtime_identity(agent:"codex", ui_pid:<pid>)` path to persist `tmux_pane_id`, `ui_tty`, and `runtime_ui_pid`
3. Delete the consumed pre-reg row
4. Return the normal `register_agent` success envelope without the "no usable tmux_pane_id" hint

#### Scenario: Single matching pre-reg auto-binds pane
- **GIVEN** `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"U1"})` has been called
- **AND** tmux pane `%1972` has a `codex --remote` process whose argv contains `xats.agent_id="U1"` with pid `91131`
- **WHEN** the codex agent calls `register_agent({client:"codex", name:"new-gpt", model:"gpt-5", project_dir:"/p"})`
- **THEN** the daemon binds `tmux_pane_id="%1972"` with `runtime_ui_pid=91131`
- **AND** the pre-reg row for `%1972` is deleted
- **AND** the response does not include the `No usable tmux_pane_id is bound yet` hint

#### Scenario: No matching pre-reg falls back to existing behavior
- **WHEN** `register_agent({client:"codex", name:"n"})` arrives with no pending pre-regs
- **THEN** the daemon takes the existing no-`ui_pid` / no-pane code path (including the standard `detect_tmux_pane` fallback and the "no usable tmux_pane_id" hint when ambiguous)
- **AND** no new error is introduced

#### Scenario: Pre-reg present but argv UUID missing does not auto-bind
- **GIVEN** `pre_register_codex_pane({pane_id:"%1972", xats_agent_id:"U1"})` has been called
- **AND** pane `%1972` runs a `codex --remote` process whose argv does NOT contain `xats.agent_id="U1"` (for example the launcher forgot the `-c` flag)
- **WHEN** a codex `register_agent` call arrives
- **THEN** the daemon does not auto-bind via this pre-reg
- **AND** the pre-reg row remains until it expires or is overwritten
- **AND** registration falls back to the existing no-pane hint path

#### Scenario: Multiple matching pre-regs do not auto-bind
- **GIVEN** two pending pre-regs, one for `%1972` (UUID U1) and one for `%1970` (UUID U2)
- **AND** both panes run `codex --remote` processes whose argv contains the respective stored UUID
- **WHEN** a single codex `register_agent` call arrives with no `ui_pid`
- **THEN** the daemon does NOT pick one arbitrarily — auto-bind is skipped to avoid cross-session misbinding
- **AND** registration falls back to the existing no-pane hint path
- **AND** both pre-reg rows remain until expiry or explicit re-claim

### Requirement: Auto-bind failure does not corrupt register_agent result

Any failure inside the pre-reg lookup / argv matching / `bind_runtime_identity` chain (tmux unavailable, ps failure, bind error, IO error) SHALL be caught and SHALL NOT propagate as a `register_agent` error.  The daemon SHALL log the failure at debug level and fall back to the existing no-pane hint path.  The registered `agent_id` row SHALL be identical to what would have been persisted without the pre-reg feature.

#### Scenario: tmux unavailable during auto-bind
- **GIVEN** a pending pre-reg for pane `%1972`
- **AND** `tmux list-panes` fails because tmux is not running
- **WHEN** a codex `register_agent` call arrives
- **THEN** the daemon returns the standard register_agent success envelope with the no-pane hint
- **AND** the pre-reg row is not deleted (so a later retry can still succeed)
- **AND** no error is raised to the caller

#### Scenario: bind_runtime_identity internal error
- **GIVEN** a pending pre-reg and a matching UI pid
- **AND** `bind_runtime_identity` fails internally (e.g., SQLite write error)
- **WHEN** a codex `register_agent` call arrives
- **THEN** the daemon returns the standard register_agent success envelope with the no-pane hint
- **AND** the agent row is still persisted (client=codex, name, etc.)
- **AND** the pre-reg row is not deleted
