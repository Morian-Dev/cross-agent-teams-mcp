## ADDED Requirements

### Requirement: Message wake delivery status is persisted

For every successful `send_message`, `broadcast`, or `broadcast_to_role` recipient row, the daemon SHALL persist one wake delivery status row keyed by `(message_id, agent_id)`.  The row MUST represent only the auto-poke wake-hint state, not mailbox persistence.

The status row MUST include:

- `message_id`
- `agent_id`
- `wake_status`, one of `delivered`, `retrying`, `skipped`, `failed`
- `skip_reason`, nullable, using existing skip reasons plus `auto_poke_disabled`, `recipient_active`, and `retry_exhausted`
- `retry_attempts`, integer, default `0`
- `updated_at`
- `delivered_at`, nullable

When `auto_poke:false` is used, the daemon MUST write `wake_status='skipped'` and `skip_reason='auto_poke_disabled'` for each recipient.

#### Scenario: Immediate auto-poke success records delivered
- **GIVEN** agent A sends `send_message({to_agent_id: B, body: "hi"})`
- **AND** B has an idle delivery transport
- **WHEN** the send succeeds and auto-poke succeeds immediately
- **THEN** the status row for `(message_id, B)` has `wake_status='delivered'`
- **AND** `delivered_at` is not null
- **AND** `skip_reason` is null

#### Scenario: auto_poke false records disabled skip
- **GIVEN** agent A sends `send_message({to_agent_id: B, body: "hi", auto_poke:false})`
- **WHEN** the send succeeds
- **THEN** the status row for `(message_id, B)` has `wake_status='skipped'`
- **AND** `skip_reason='auto_poke_disabled'`
- **AND** no wake delivery transport is invoked

#### Scenario: Guard failed records retrying
- **GIVEN** agent A sends a message to B and B's pane is active
- **WHEN** the initial quiet-guard fails and retry is scheduled
- **THEN** the status row for `(message_id, B)` has `wake_status='retrying'`
- **AND** `skip_reason='guard_failed'`
- **AND** `retry_attempts=0`

### Requirement: Sender can query delivery status

The daemon SHALL expose a read-only MCP tool named `get_delivery_status` that accepts `{ message_id: string }`.  The caller MUST be the sender of the requested message; otherwise the daemon MUST return `{ error: 'unknown_message' }` without exposing recipient status.

On success, the tool SHALL return:

- `message_id`
- `statuses: Array<{ agent_id, wake_status, skip_reason?, retry_attempts, updated_at, delivered_at? }>`

#### Scenario: Sender reads status for a direct message
- **GIVEN** agent A sent message `m1` to agent B
- **WHEN** A calls `get_delivery_status({message_id:'m1'})`
- **THEN** the response includes exactly one status row for B
- **AND** the row reports B's current `wake_status`

#### Scenario: Non-sender cannot read status
- **GIVEN** agent A sent message `m1` to agent B
- **AND** agent C is registered
- **WHEN** C calls `get_delivery_status({message_id:'m1'})`
- **THEN** the response is `{ error: 'unknown_message' }`

#### Scenario: Broadcast sender reads per-recipient statuses
- **GIVEN** agent A sent broadcast message `m1` to agents B and C
- **WHEN** A calls `get_delivery_status({message_id:'m1'})`
- **THEN** the response includes one status row for B and one status row for C

### Requirement: Task creation does not provide direct notification

`task_add` SHALL remain a pure task-list mutation.  It MUST NOT accept `notify_agent_id`, `assignee_agent_id`, `auto_poke`, or any equivalent parameter that directly wakes or targets a specific agent.  Its MCP description MUST NOT instruct agents to call `poke`.

Agents that want another agent to notice a task MUST use normal mailbox messaging and then query that message's delivery status.

#### Scenario: task_add schema has no notification parameter
- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the schema for `task_add`
- **THEN** the schema includes task fields such as `title`, `description`, and `depends_on`
- **AND** the schema does not include `notify_agent_id`, `assignee_agent_id`, `auto_poke`, or `target_agent_id`

#### Scenario: task_add description does not recommend poke
- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the description for `task_add`
- **THEN** the description does not contain `poke`

## MODIFIED Requirements

### Requirement: Auto-poke retry with backoff on guard_failed

When the initial auto-poke guard returns `guard_failed` for a recipient that has a registered `tmux_pane_id`, the daemon MUST schedule up to three background retries with fixed delays: 30 seconds, 180 seconds (3 minutes), and 600 seconds (10 minutes).  Retries MUST NOT be scheduled for recipients whose skip reason is `no_pane`, `self`, or `tmux_unavailable` — only `guard_failed`.

This Requirement applies uniformly to `send_message` (including cross-team), `broadcast`, and `broadcast_to_role`.

Each retry tick MUST:

1. Look up the recipient's current `tmux_pane_id` and `last_seen_at` from the database (no team filter — `agent_id` is globally unique).
2. If the recipient no longer exists or has no pane id: mark the delivery status `failed` with `skip_reason='no_pane'` and stop retrying for that recipient.
3. If `last_seen_at > sent_at` of the originating message: mark the delivery status `skipped` with `skip_reason='recipient_active'` and stop retrying.
4. Otherwise: invoke `runQuietGuard(pane_id)`.  Pass → fire poke with the hint-format wake-up prompt, mark delivery status `delivered`, set `delivered_at`, and stop remaining retries.  Fail → increment `retry_attempts`; if attempts remain, keep status `retrying`; if no attempts remain, mark status `failed` with `skip_reason='retry_exhausted'`.

The sending tool's response (`send_message`, `broadcast`, or `broadcast_to_role`) MUST include:

- `retry_scheduled: boolean` — `true` iff the daemon scheduled at least one retry for any recipient.
- `retry_delays_s?: number[]` — the backoff sequence used (MUST equal `[30, 180, 600]` when `retry_scheduled` is `true`; MAY be absent when `false`).

The daemon MUST clear all pending retry timers on shutdown (e.g. Fastify `onClose` hook) to avoid leaking timer handles.  Retry outcomes MUST NOT write new events or messages back to the sender; they update only the wake delivery status rows.

#### Scenario: Guard_failed recipient schedules 3 retries

- **GIVEN** A and B registered with `tmux_pane_id`, same team, B's pane active, `POKE_QUIET_MS=50`
- **WHEN** A calls `send_message({ to_agent_id: B, body: "hi" })`
- **THEN** response has `poked: false`, `poke_skip_reasons: [{ agent_id: B, reason: 'guard_failed' }]`
- **AND** response has `retry_scheduled: true`, `retry_delays_s: [30, 180, 600]`
- **AND** the daemon's internal retry map has exactly one entry keyed by `${message_id}:${B}`
- **AND** the delivery status for B is `retrying` with `skip_reason='guard_failed'`

#### Scenario: First retry tick guard passes → poke fires, remaining cancelled

- **GIVEN** the setup above with a retry already scheduled, pointer to attempt 1
- **AND** test uses fake timers, B's pane becomes idle (guard will pass on re-check)
- **WHEN** 30 seconds of fake-time advance
- **THEN** a poke is fired at B's pane
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
