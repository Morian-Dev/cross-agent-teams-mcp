## ADDED Requirements

### Requirement: Send-message auto-poke default with quiet-guard

`send_message` MUST accept an optional `auto_poke: boolean` parameter.  When the parameter is omitted, the default value MUST be `true` for both `to_agent_id` (single-recipient) and `to_role` (role-fanout) cases.

When `auto_poke` resolves to `true` for a given recipient, the daemon MUST run a quiet-guard before firing `poke`:

1. Capture the recipient's pane tail via `tmux capture-pane` (if `tmux_pane_id` is registered).
2. Wait `POKE_QUIET_MS` milliseconds (default 2000, overridable via environment variable, positive integer).
3. Re-capture the pane tail and compare the two captures (string-equal or equivalent hash).
4. If the captures match (pane has been idle): fire the poke to that recipient.
5. If the captures differ (pane has activity): skip the poke for that recipient; the message MUST still be persisted in the mailbox.

The daemon MUST skip the poke and record a skip reason when any of the following apply: the recipient has no registered `tmux_pane_id` (reason `no_pane`), `tmux` is not available on PATH (reason `tmux_unavailable`), the quiet-guard detects activity (reason `guard_failed`), or the recipient is the caller itself (reason `self`).

The `send_message` response MUST include:

- `poked: boolean` — `true` iff at least one intended recipient was successfully poked.
- `poke_skip_reasons?: Array<{ agent_id: string; reason: 'no_pane' | 'guard_failed' | 'tmux_unavailable' | 'self' }>` — one entry per recipient for which `auto_poke` was requested but skipped.  Absent when `auto_poke` resolves to `false`.

Multiple recipients (via `to_role`) MUST be guarded in parallel, so the total caller wait-time approximates one `POKE_QUIET_MS` window rather than `N × POKE_QUIET_MS`.

When the caller provides `auto_poke: false` explicitly, the daemon MUST NOT invoke poke or the guard; the response MUST have `poked: false` and omit `poke_skip_reasons`.

#### Scenario: Single recipient, idle pane, default triggers poke

- **GIVEN** agent A and agent B are registered with `tmux_pane_id` values, on the same team
- **AND** agent B's tmux pane has been idle (no output for ≥ `POKE_QUIET_MS`)
- **AND** `POKE_QUIET_MS=100` for test-speed
- **WHEN** agent A calls `send_message({ to_agent_id: B, body: "hi" })` (auto_poke omitted)
- **THEN** the message is persisted in B's mailbox
- **AND** the response has `poked: true`
- **AND** `poke_skip_reasons` is absent or empty
- **AND** B's tmux pane has received the poke injection

#### Scenario: Recipient's pane is active, guard fails, falls back to mailbox

- **GIVEN** agent A and agent B registered with `tmux_pane_id`, same team
- **AND** B's pane is actively outputting (hash changes across the 100ms window)
- **AND** `POKE_QUIET_MS=100`
- **WHEN** agent A calls `send_message({ to_agent_id: B, body: "hi" })`
- **THEN** the message is persisted in B's mailbox
- **AND** the response has `poked: false`
- **AND** `poke_skip_reasons` contains `{ agent_id: B, reason: 'guard_failed' }`

#### Scenario: Recipient has no tmux_pane_id

- **GIVEN** agent A registered with `tmux_pane_id`, agent B registered WITHOUT `tmux_pane_id`, same team
- **WHEN** agent A calls `send_message({ to_agent_id: B, body: "hi" })`
- **THEN** the message is persisted in B's mailbox
- **AND** response `poked: false`
- **AND** `poke_skip_reasons` contains `{ agent_id: B, reason: 'no_pane' }`

#### Scenario: auto_poke:false disables the behavior entirely

- **GIVEN** A and B both registered with tmux pane ids, idle pane
- **WHEN** A calls `send_message({ to_agent_id: B, body: "hi", auto_poke: false })`
- **THEN** the message is persisted in B's mailbox
- **AND** response `poked: false`
- **AND** `poke_skip_reasons` is absent
- **AND** B's pane is NOT injected (no guard attempt either)

#### Scenario: to_role fan-out, parallel guards

- **GIVEN** A, B, C registered on same team; B has role=`worker`, idle pane; C has role=`worker`, active pane; `POKE_QUIET_MS=100`
- **WHEN** A calls `send_message({ to_role: 'worker', body: "hi" })`
- **THEN** the message is persisted in both B and C's mailboxes
- **AND** the total call duration is < 400ms (parallel, not 2×100ms serial plus overhead)
- **AND** response `poked: true` (because B was poked)
- **AND** `poke_skip_reasons` contains `{ agent_id: C, reason: 'guard_failed' }` (only C skipped)

#### Scenario: Invalid POKE_QUIET_MS env falls back to default

- **GIVEN** `process.env.POKE_QUIET_MS = 'not-a-number'`
- **WHEN** daemon boots and handles an auto-poke send_message
- **THEN** the quiet window is 2000ms (default)
- **AND** the daemon does not crash

### Requirement: Broadcast auto-poke is opt-in

`broadcast` MUST accept an optional `auto_poke: boolean` parameter.  When omitted, the default MUST be `false` (to avoid mass-poke noise on team-wide messages).

When the caller explicitly passes `auto_poke: true`, the daemon MUST apply the same quiet-guard per recipient as the send-message auto-poke rule, with the same parallel fan-out and the same skip-reason taxonomy.

The `broadcast` response MUST include `poked: boolean` and the optional `poke_skip_reasons` field following the same shape as send-message.

#### Scenario: Default broadcast does not poke anyone

- **GIVEN** team has agents A, B, C, D all registered with tmux pane ids
- **WHEN** A calls `broadcast({ body: "status update" })` (auto_poke omitted)
- **THEN** B, C, D each have the message in their mailbox
- **AND** the response has `poked: false`
- **AND** `poke_skip_reasons` is absent
- **AND** no tmux injection happens

#### Scenario: Explicit broadcast auto_poke:true pokes every eligible pane

- **GIVEN** team has A, B, C with tmux pane ids; D without; all idle panes; `POKE_QUIET_MS=100`
- **WHEN** A calls `broadcast({ body: "urgent", auto_poke: true })`
- **THEN** B, C, D all have the message in mailbox
- **AND** response `poked: true`
- **AND** `poke_skip_reasons` contains `{ agent_id: D, reason: 'no_pane' }`
- **AND** B and C's panes receive the injection
