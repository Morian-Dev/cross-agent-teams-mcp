## MODIFIED Requirements

### Requirement: Send-message auto-poke default with quiet-guard

`send_message` MUST accept an optional `auto_poke: boolean` parameter.  When the parameter is omitted, the default value MUST be `true` — for same-team AND cross-team calls alike.

When `auto_poke` resolves to `true`, the daemon MUST invoke the internal poke primitive for the single recipient.  The primitive performs transport selection and fallback per "poke dispatches via transport abstraction".  The fan-out layer MUST NOT run its own transport-type-gated quiet-guard; the tmux quiet-guard is run by the poke primitive if and only if dispatch reaches the tmux paste branch (per "poke happy path delivers paste and returns before/after tails").  Consequently a recipient with a configured non-tmux transport that is currently unreachable MAY still fall back to a guarded tmux paste, and resolves to `guard_failed` when its pane is active.

The quiet-guard mechanics are unchanged: capture the pane tail, wait `POKE_QUIET_MS` milliseconds (default 2000, overridable via environment variable, positive integer), re-capture, and compare; matching captures (idle pane) allow the paste, differing captures (pane activity) yield `guard_failed` with no paste.  The message MUST still be persisted in the mailbox regardless of the poke outcome.

The daemon MUST skip the poke and record a skip reason when any of the following apply: the recipient has no reachable transport and no registered `tmux_pane_id` (reason `no_pane`), `tmux` is not available on PATH for a tmux-only recipient (reason `tmux_unavailable`), the quiet-guard detects activity on the tmux paste branch (reason `guard_failed`), or the recipient is the caller itself (reason `self`).

The `send_message` response MUST include:

- `message_id, event_id, recipients: string[]` (recipients has length exactly 1 when successful)
- `poked: boolean` — `true` iff the intended recipient was successfully poked.
- `poke_skip_reasons?: Array<{ agent_id: string; reason: 'no_pane' | 'guard_failed' | 'tmux_unavailable' | 'self' }>` — present with one entry when the poke was skipped.  Absent when `auto_poke` resolves to `false`.

When the caller provides `auto_poke: false` explicitly, the daemon MUST NOT invoke poke or the guard; the response MUST have `poked: false` and omit `poke_skip_reasons`.

Cross-team auto-poke is identical: the recipient's `tmux_pane_id` is looked up by `agent_id` alone (since agent_id is globally unique), and the poke is injected into that pane.

#### Scenario: Single recipient same-team, idle pane, default triggers poke

- **GIVEN** agent A and agent B are registered with `tmux_pane_id` values on the same team
- **AND** agent B's tmux pane has been idle, `POKE_QUIET_MS=100` for test speed
- **WHEN** agent A calls `send_message_by_id({ to_agent_id: B, body: "hi" })` (auto_poke omitted)
- **THEN** the message is persisted in B's mailbox with `from_team=to_team`
- **AND** the response has `poked: true`
- **AND** B's tmux pane has received the poke injection

#### Scenario: Cross-team auto-poke fires when recipient pane idle

- **GIVEN** agent `alice` in team `alpha` and agent `bob` (`agent_id=B`) in team `beta`, both with `tmux_pane_id`
- **AND** bob's pane idle, `POKE_QUIET_MS=100`
- **WHEN** alice calls `send_message({to_agent_name: 'bob', to_team: 'beta', body: "hi"})` (auto_poke omitted)
- **THEN** the message is persisted with `from_team='alpha', to_team='beta'`
- **AND** the response has `poked: true`
- **AND** bob's pane received the poke injection

#### Scenario: Recipient's pane is active, guard fails, falls back to mailbox

- **GIVEN** agent A and B same team, both with `tmux_pane_id`, B's pane actively outputting, `POKE_QUIET_MS=100`
- **WHEN** A calls `send_message_by_id({to_agent_id: B, body:"hi"})`
- **THEN** the message is persisted
- **AND** response `poked: false` with `poke_skip_reasons` containing `{agent_id: B, reason: 'guard_failed'}`

#### Scenario: Recipient has no transport

- **GIVEN** B registered without `tmux_pane_id` and without any configured non-tmux transport (same or cross team)
- **WHEN** A calls `send_message_by_id({to_agent_id: B, body: "hi"})`
- **THEN** response `poked: false` with `poke_skip_reasons` containing `{agent_id: B, reason: 'no_pane'}`

#### Scenario: Recipient with claude-channel delivery does not require tmux pane

- **GIVEN** B is registered with `delivery={kind:'claude-channel', channel_session_id:'csid-b'}` and no `tmux_pane_id`
- **AND** the channel proxy subscribing to `csid-b` is online
- **WHEN** A calls `send_message_by_id({to_agent_id: B, body: "hi"})` (auto_poke omitted)
- **THEN** the poke primitive delivers via the claude-channel transport without reaching the tmux paste branch, so no quiet-guard runs
- **AND** the response has `poked: true`
- **AND** `poke_skip_reasons` is absent or empty

#### Scenario: Recipient with opencode binding does not require tmux pane

- **GIVEN** B is registered with `opencode_base_url='http://127.0.0.1:4096'`, `opencode_session_id='sess-b'`, and no `tmux_pane_id`
- **AND** the opencode server accepts the wake prompt for `sess-b`
- **WHEN** A calls `send_message_by_id({to_agent_id: B, body: "hi"})` (auto_poke omitted)
- **THEN** the poke primitive delivers via the opencode transport without reaching the tmux paste branch, so no quiet-guard runs
- **AND** the response has `poked: true`
- **AND** `poke_skip_reasons` is absent or empty

#### Scenario: Channel recipient with offline sink falls back to guarded tmux against active pane

- **GIVEN** B is registered with `delivery={kind:'claude-channel', channel_session_id:'csid-b'}` AND `tmux_pane_id='%42'`
- **AND** no sink is attached for `csid-b` (channel offline) and B has no bound opencode session
- **AND** `%42` is actively redrawing, `POKE_QUIET_MS=100` for test speed
- **WHEN** A calls `send_message_by_id({to_agent_id: B, body: "hi"})` (auto_poke omitted)
- **THEN** the poke primitive falls back to the tmux branch, runs the quiet-guard, and detects activity
- **AND** the response has `poked: false` with `poke_skip_reasons` containing `{agent_id: B, reason: 'guard_failed'}`
- **AND** `retry_scheduled: true`, `retry_delays_s: [30, 180, 600]`
- **AND** no paste is injected into `%42`

#### Scenario: auto_poke:false disables the behavior entirely

- **GIVEN** A and B both registered with tmux pane ids, idle pane
- **WHEN** A calls `send_message_by_id({to_agent_id: B, body: "hi", auto_poke: false})`
- **THEN** the message persists, response `poked: false`, `poke_skip_reasons` absent, B's pane NOT injected

#### Scenario: Invalid POKE_QUIET_MS env falls back to default

- **GIVEN** `process.env.POKE_QUIET_MS = 'not-a-number'`
- **WHEN** daemon boots and handles an auto-poke send_message
- **THEN** the quiet window is 2000ms (default) and the daemon does not crash

### Requirement: Broadcast auto-poke default with parallel fan-out

`broadcast` MUST accept an optional `auto_poke: boolean` parameter. When omitted, the default MUST be `true` (matching `send_message` behavior). When the caller explicitly passes `auto_poke: false`, the daemon MUST persist the message to every recipient's mailbox and skip all guard / poke / retry logic; the response MUST have `poked: false`, omit `poke_skip_reasons`, and have `retry_scheduled: false`.

When `auto_poke` resolves to `true`, the daemon MUST:

1. Persist the message to every recipient's mailbox (one row per recipient sharing one `event_id`, all with `from_team=to_team=caller.team`).
2. For every recipient, in parallel via `Promise.all`, invoke the internal poke primitive.  The primitive performs transport selection + fallback and runs the tmux quiet-guard if and only if it reaches the tmux paste branch (per "poke dispatches via transport abstraction" and "poke happy path delivers paste and returns before/after tails").  The fan-out layer MUST NOT run its own transport-type-gated guard.  A recipient whose only reachable route is a tmux paste against an active pane resolves to `guard_failed`; a recipient with no reachable transport and no `tmux_pane_id` resolves to `no_pane`; a tmux-only recipient with `tmux` not on PATH resolves to `tmux_unavailable`; the caller resolves to `self` (broadcast already excludes sender, but defensive).
3. For every recipient that resulted in `guard_failed` AND has a `tmux_pane_id`, schedule the same 3-attempt retry-with-backoff (30s / 180s / 600s) specified in "Auto-poke retry with backoff on guard_failed".
4. The total wall-clock duration MUST approximate one `POKE_QUIET_MS` window (~2000ms default), not `N × POKE_QUIET_MS`, because guards run in parallel.

The `broadcast` response MUST include:

- `poked: boolean` — `true` iff at least one recipient was successfully poked.
- `poke_skip_reasons?: Array<{ agent_id: string; reason: 'no_pane' | 'guard_failed' | 'tmux_unavailable' | 'self' }>` — one entry per recipient that was attempted but skipped. Absent when `auto_poke` resolves to `false`.
- `retry_scheduled: boolean` — `true` iff at least one recipient was queued for retry.
- `retry_delays_s?: number[]` — equals `[30, 180, 600]` when `retry_scheduled` is `true`; absent otherwise.

The `broadcast` MCP tool description MUST state that auto-poke is the default, that the tool targets the caller's team only (no cross-team variant), and SHOULD reference `broadcast_to_role` as the way to restrict by role.

#### Scenario: Default broadcast pokes every idle pane in parallel

- **GIVEN** team has agents A, B, C, D all registered with `tmux_pane_id` and idle panes
- **AND** `POKE_QUIET_MS=100` for test speed
- **WHEN** A calls `broadcast({body:'status update'})` (auto_poke omitted)
- **THEN** B, C, D each have the message in their mailbox
- **AND** the response has `poked: true`
- **AND** `poke_skip_reasons` is absent or empty
- **AND** B, C, D's panes have all received poke injection
- **AND** the total call duration is < 400ms (parallel, not 3 × 100ms serial plus overhead)

#### Scenario: Default broadcast with mixed pane states reports per-recipient skip reasons

- **GIVEN** team has A, B, C with `tmux_pane_id` and D without
- **AND** B's pane is idle, C's pane is active, `POKE_QUIET_MS=100`
- **WHEN** A calls `broadcast({body:'mixed'})` (auto_poke omitted)
- **THEN** B, C, D all have the message in mailbox
- **AND** response `poked: true` (because B was poked)
- **AND** `poke_skip_reasons` contains `{agent_id: C, reason: 'guard_failed'}` and `{agent_id: D, reason: 'no_pane'}`
- **AND** `retry_scheduled: true`, `retry_delays_s: [30, 180, 600]` (because C is in retry queue)

#### Scenario: Explicit auto_poke:false reverts to pure mailbox delivery

- **GIVEN** team has A, B, C all with idle `tmux_pane_id`
- **WHEN** A calls `broadcast({body:'low priority', auto_poke:false})`
- **THEN** B, C have the message in mailbox
- **AND** response `poked: false`, `poke_skip_reasons` absent, `retry_scheduled: false`
- **AND** no `tmux capture-pane` or `send-keys` command was issued for B or C

#### Scenario: Broadcast tool description states same-team scope and default-on auto-poke

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of the tool named `broadcast`
- **THEN** the description SHOULD state that auto-poke is the default
- **AND** SHOULD reference `auto_poke:false` as the opt-out parameter
- **AND** SHOULD clarify that `broadcast` is same-team only and point at `broadcast_to_role` for role filtering

#### Scenario: Default broadcast with active panes schedules retries identical to send_message

- **GIVEN** team has A, B, C with `tmux_pane_id`, B and C panes both active, `POKE_QUIET_MS=50`
- **WHEN** A calls `broadcast({body:'urgent'})` (auto_poke omitted)
- **THEN** B and C have the message in mailbox
- **AND** response `poked: false`, `poke_skip_reasons` contains both guard_failed entries
- **AND** `retry_scheduled: true`, `retry_delays_s: [30, 180, 600]`
- **AND** the daemon's internal retry map has 2 entries (one per recipient)

### Requirement: poke dispatches via transport abstraction

`poke({target_agent_id, prompt})` SHALL perform transport selection and fallback as follows:

1. Look up the target row: `SELECT channel_session_id, opencode_base_url, opencode_session_id, tmux_pane_id, team FROM agents WHERE agent_id = ?`.
2. If the target does not exist, return `{error: 'unknown_target'}`.
3. Self-poke and cross-team checks remain unchanged; `allowCrossTeam` internal flag still governs auto-poke bypass.
4. If `channel_session_id` is non-null AND the daemon's `ChannelWakeFanout` has a live sink attached for that id, call the internal `sendChannelWake(channel_session_id, {content, meta})`.  On success, return `{ok: true, transport_used: 'claude-channel', channel_session_id}`.
5. Otherwise, if both `opencode_base_url` and `opencode_session_id` are non-null, call the internal opencode transport helper.  On success, return `{ok: true, transport_used: 'opencode-server', base_url, session_id}`.
6. If steps 4-5 did not return success, AND `tmux_pane_id` is non-null, perform the existing tmux-based poke flow, which runs the quiet-guard before pasting UNLESS the internal `skipGuard` flag is set (per "poke happy path delivers paste and returns before/after tails").  On success, return `{ok: true, pane_id, pane_tail_before, pane_tail_after, transport_used: 'tmux-poke'}`.  When the guard detects pane activity (and `skipGuard` is not set), return `{error: 'guard_failed', transport_used: 'tmux-poke'}` without pasting.  On other tmux error, return the classified error with `transport_used: 'tmux-poke'`.
7. If none of the three transports is configured, return `{error: 'no_transport_available', detail: {channel_subscribed: <bool>, opencode_bound: <bool>, tmux_pane_set: <bool>}}`.

The tool MUST NOT fan a wake-up via multiple transports for a single poke call.  Successful Claude channel delivery short-circuits opencode and tmux, and successful opencode delivery short-circuits tmux.

#### Scenario: poke prefers claude-channel over opencode and tmux

- **GIVEN** target agent `bob` has `channel_session_id='csid-bob'`, `opencode_base_url='http://127.0.0.1:4096'`, `opencode_session_id='sess-bob'`, and `tmux_pane_id='%99'`
- **AND** the channel proxy subscribing to `csid-bob` is online
- **WHEN** `alice` calls `poke({target_agent_id:'bob', prompt:'p'})`
- **THEN** the response is `{ok: true, transport_used: 'claude-channel', channel_session_id: 'csid-bob'}`
- **AND** the daemon does NOT call the opencode transport helper
- **AND** no `tmux` command is executed

#### Scenario: poke uses opencode when channel sink absent and opencode bound

- **GIVEN** target `bob` has `channel_session_id='csid-bob'`, `opencode_base_url='http://127.0.0.1:4096'`, `opencode_session_id='sess-bob'`, and `tmux_pane_id='%99'`
- **AND** no sink is attached for `csid-bob`
- **AND** the opencode server is reachable and accepts the prompt for `sess-bob`
- **WHEN** `alice` calls `poke({target_agent_id:'bob', prompt:'p'})`
- **THEN** the response is `{ok: true, transport_used: 'opencode-server', base_url: 'http://127.0.0.1:4096', session_id: 'sess-bob'}`
- **AND** no `tmux` command is executed

#### Scenario: poke falls back to tmux when opencode not bound and pane idle

- **GIVEN** target `bob` has `channel_session_id=NULL`, `opencode_base_url=NULL`, `opencode_session_id=NULL`, and `tmux_pane_id='%99'`
- **AND** `%99` stays idle through the quiet-guard window, so the guard passes
- **WHEN** `alice` calls `poke({target_agent_id:'bob', prompt:'p'})`
- **THEN** the daemon executes the tmux paste-then-enter flow on pane `%99`
- **AND** the response is `{ok: true, transport_used: 'tmux-poke', pane_id: '%99', pane_tail_before: ..., pane_tail_after: ...}`

#### Scenario: tmux fallback guards an active pane and returns guard_failed

- **GIVEN** target `bob` has `channel_session_id='csid-bob'` but no live sink for it, `opencode_base_url=NULL`, and `tmux_pane_id='%99'`
- **AND** `%99` is actively redrawing during the quiet-guard window
- **AND** the poke is invoked without `skipGuard`
- **WHEN** `alice` pokes `bob`
- **THEN** the dispatch falls through steps 4-5 to the tmux branch, runs the quiet-guard, and detects activity
- **AND** the response is `{error: 'guard_failed', transport_used: 'tmux-poke'}`
- **AND** no `paste-buffer` / `send-keys` command is executed on `%99`

#### Scenario: poke returns no_transport_available when no route is configured

- **GIVEN** target `bob` has `channel_session_id=NULL`, `opencode_base_url=NULL`, `opencode_session_id=NULL`, and `tmux_pane_id=NULL`
- **WHEN** `alice` calls `poke({target_agent_id:'bob', prompt:'p'})`
- **THEN** the response is `{error: 'no_transport_available', detail: {channel_subscribed: false, opencode_bound: false, tmux_pane_set: false}}`
- **AND** no tmux command is executed

#### Scenario: poke response envelope carries expanded transport_used values

- **GIVEN** any poke call that succeeds via one transport
- **WHEN** the response envelope is inspected
- **THEN** the envelope contains a `transport_used` field whose value is one of `'claude-channel'`, `'opencode-server'`, or `'tmux-poke'`

### Requirement: Auto-poke retry with backoff on guard_failed

When the initial auto-poke guard returns `guard_failed` for a recipient that has a registered `tmux_pane_id`, the daemon MUST schedule up to three background retries with fixed delays: 30 seconds, 180 seconds (3 minutes), and 600 seconds (10 minutes).  Retries MUST NOT be scheduled for recipients whose skip reason is `no_pane`, `self`, or `tmux_unavailable` — only `guard_failed`.

This Requirement applies uniformly to `send_message` (including cross-team), `broadcast`, and `broadcast_to_role`.

Each retry tick MUST:

1. Look up the recipient's current `tmux_pane_id` and `last_seen_at` from the database (no team filter — `agent_id` is globally unique).
2. If the recipient no longer exists or has no pane id: mark the delivery status `failed` with `skip_reason='no_pane'` and stop retrying for that recipient.
3. If `last_seen_at > sent_at` of the originating message: mark the delivery status `skipped` with `skip_reason='recipient_active'` and stop retrying.
4. Otherwise: invoke `runQuietGuard(pane_id)`.  Pass → fire poke with the hint-format wake-up prompt AND the internal `skipGuard` flag set (the tick has already run the quiet-guard, so the poke primitive MUST NOT re-run it — this avoids a redundant second `POKE_QUIET_MS` wait), mark delivery status `delivered`, set `delivered_at`, and stop remaining retries.  Fail → increment `retry_attempts`; if attempts remain, keep status `retrying`; if no attempts remain, mark status `failed` with `skip_reason='retry_exhausted'`.

The sending tool's response (`send_message`, `broadcast`, or `broadcast_to_role`) MUST include:

- `retry_scheduled: boolean` — `true` iff the daemon scheduled at least one retry for any recipient.
- `retry_delays_s?: number[]` — the backoff sequence used (MUST equal `[30, 180, 600]` when `retry_scheduled` is `true`; MAY be absent when `false`).

The daemon MUST clear all pending retry timers on shutdown (e.g. Fastify `onClose` hook) to avoid leaking timer handles.  Retry outcomes MUST NOT write new events or messages back to the sender; they update only the wake delivery status rows.

#### Scenario: Guard_failed recipient schedules 3 retries

- **GIVEN** A and B registered with `tmux_pane_id`, same team, B's pane active, `POKE_QUIET_MS=50`
- **WHEN** A calls `send_message_by_id({ to_agent_id: B, body: "hi" })`
- **THEN** response has `poked: false`, `poke_skip_reasons: [{ agent_id: B, reason: 'guard_failed' }]`
- **AND** response has `retry_scheduled: true`, `retry_delays_s: [30, 180, 600]`
- **AND** the daemon's internal retry map has exactly one entry keyed by `${message_id}:${B}`
- **AND** the delivery status for B is `retrying` with `skip_reason='guard_failed'`

#### Scenario: First retry tick guard passes → poke fires with skipGuard, remaining cancelled

- **GIVEN** the setup above with a retry already scheduled, pointer to attempt 1
- **AND** test uses fake timers, B's pane becomes idle (the tick's guard will pass on re-check)
- **WHEN** 30 seconds of fake-time advance
- **THEN** a poke is fired at B's pane with the internal `skipGuard` flag set (the poke primitive does not re-run the guard)
- **AND** the retry map has no entry for this message/recipient
- **AND** no further timers fire
- **AND** the delivery status for B is `delivered`

#### Scenario: Recipient activity cancels pending retries

- **GIVEN** a retry scheduled at attempt 2 (after attempt 1 also guard_failed)
- **AND** fake timer at t = 35s (past attempt 1, before attempt 2's 180s)
- **WHEN** the recipient makes any MCP call that updates its `last_seen_at` (e.g. `get_inbox`)
- **AND** fake timer advances past attempt 2 (t = 235s)
- **THEN** attempt 2 ticks, observes `last_seen_at > sent_at`, and stops
- **AND** no poke fires on or after t=235s
- **AND** the retry map has no entry after the stop
- **AND** the delivery status for B is `skipped` with `skip_reason='recipient_active'`

#### Scenario: All 3 retries guard_fail, message remains in mailbox only

- **GIVEN** B's pane stays active through all three retry windows
- **WHEN** fake timer advances past 30s, 180s, 600s (total 810s)
- **THEN** no poke ever fires for this send
- **AND** the retry map has no entry after attempt 3 fails
- **AND** the message row in `messages` table for B is intact
- **AND** the delivery status for B is `failed` with `skip_reason='retry_exhausted'`
