## ADDED Requirements

### Requirement: Auto-poke retry with backoff on guard_failed

When the initial auto-poke guard returns `guard_failed` for a recipient that has a registered `tmux_pane_id`, the daemon MUST schedule up to three background retries with fixed delays: 30 seconds, 180 seconds (3 minutes), and 600 seconds (10 minutes).  Retries MUST NOT be scheduled for recipients whose skip reason is `no_pane`, `self`, or `tmux_unavailable` — only `guard_failed`.

Each retry tick MUST:

1. Look up the recipient's current `tmux_pane_id` and `last_seen_at` from the database.
2. If the recipient no longer exists or has no pane id: silently stop retrying for that recipient.
3. If `last_seen_at > sent_at` of the originating message: silently stop retrying (recipient has come online / made a daemon call since the send).
4. Otherwise: invoke `runQuietGuard(pane_id)`.  Pass → fire poke with the original message body; stop remaining retries.  Fail → skip this attempt; schedule the next retry in the sequence if any remaining.

The sending tool's response (`send_message` or `broadcast`) MUST include:

- `retry_scheduled: boolean` — `true` iff the daemon scheduled at least one retry for any recipient.
- `retry_delays_s?: number[]` — the backoff sequence used (MUST equal `[30, 180, 600]` when `retry_scheduled` is `true`; MAY be absent when `false`).

The daemon MUST clear all pending retry timers on shutdown (e.g. Fastify `onClose` hook) to avoid leaking timer handles.

Retry outcomes MUST NOT write new events or messages back to the sender: a successful retry-poke is a silent side-effect; the sender's response already returned before the retry fired, and polluting the outbox with "poke_retried" notifications is out of scope.

#### Scenario: Guard_failed recipient schedules 3 retries

- **GIVEN** agent A registered with `tmux_pane_id`, agent B registered with `tmux_pane_id`, same team
- **AND** B's pane is active (guard fails)
- **AND** `POKE_QUIET_MS=50` for test speed
- **WHEN** A calls `send_message({ to_agent_id: B, body: "hi" })`
- **THEN** response has `poked: false`, `poke_skip_reasons: [{ agent_id: B, reason: 'guard_failed' }]`
- **AND** response has `retry_scheduled: true`, `retry_delays_s: [30, 180, 600]`
- **AND** the daemon's internal retry map has exactly one entry keyed by `${message_id}:${B}`

#### Scenario: First retry tick guard passes → poke fires, remaining cancelled

- **GIVEN** the setup above with a retry already scheduled, pointer to attempt 1
- **AND** test uses fake timers
- **AND** B's pane becomes idle (guard will pass on re-check)
- **WHEN** 30 seconds of fake-time advance
- **THEN** a poke is fired at B's pane
- **AND** the retry map has no entry for this message/recipient
- **AND** no further timers fire (advance 600s more → no additional pokes)

#### Scenario: Recipient activity cancels pending retries

- **GIVEN** a retry scheduled at attempt 2 (after attempt 1 also guard_failed)
- **AND** fake timer at t = 35s (past attempt 1, before attempt 2's 180s)
- **WHEN** the recipient makes any MCP call that updates its `last_seen_at` (e.g. `get_inbox`)
- **AND** fake timer advances past attempt 2 (t = 235s)
- **THEN** attempt 2 ticks, observes `last_seen_at > sent_at`, and stops
- **AND** no poke fires on or after t=235s
- **AND** the retry map has no entry after the stop

#### Scenario: All 3 retries guard_fail, message remains in mailbox only

- **GIVEN** B's pane stays active through all three retry windows
- **WHEN** fake timer advances past 30s, 180s, 600s (total 810s)
- **THEN** no poke ever fires for this send
- **AND** the retry map has no entry after attempt 3 fails
- **AND** the message row in `messages` table for B is intact (unchanged)
- **AND** no error logs propagate to the sender (silent giveup)

#### Scenario: no_pane recipient does NOT get retry

- **GIVEN** A registered with `tmux_pane_id`, B registered WITHOUT `tmux_pane_id`, same team
- **WHEN** A calls `send_message({ to_agent_id: B, body: "hi" })`
- **THEN** response has `poked: false`, `poke_skip_reasons: [{ agent_id: B, reason: 'no_pane' }]`
- **AND** response has `retry_scheduled: false`
- **AND** `retry_delays_s` is absent
- **AND** the retry map is empty

#### Scenario: Fan-out with mixed outcomes — only guard_failed recipients get retries

- **GIVEN** A, B (idle pane), C (active pane), D (no pane_id), all on same team, all role='worker'; `POKE_QUIET_MS=50`
- **WHEN** A calls `send_message({ to_role: 'worker', body: "hi" })`
- **THEN** B is poked immediately (no retry scheduled for B)
- **AND** C's skip reason is `guard_failed`, C has a retry scheduled
- **AND** D's skip reason is `no_pane`, D has NO retry scheduled
- **AND** response has `retry_scheduled: true`, `retry_delays_s: [30, 180, 600]`
- **AND** retry map has exactly one entry keyed by C

#### Scenario: Shutdown clears all pending retry timers

- **GIVEN** at least one retry scheduled (any of the above scenarios)
- **WHEN** the daemon's Fastify `app.close()` is called
- **THEN** the retry map is empty
- **AND** no timer fires after shutdown even as fake-time advances further
