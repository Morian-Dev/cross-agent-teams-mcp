# mailbox Specification

## Purpose

Deliver direct and role-based messages between agents in the same team, persisting through offline periods via the events outbox and cursor-based inbox polling.
## Requirements
### Requirement: Messages table schema and event projection

The database SHALL contain a `messages` table: `id TEXT PRIMARY KEY`, `event_id INTEGER NOT NULL REFERENCES events(event_id)`, `team TEXT NOT NULL`, `from_agent_id TEXT NOT NULL`, `to_agent_id TEXT`, `to_role TEXT`, `subject TEXT`, `body TEXT NOT NULL`, `sent_at TEXT NOT NULL`. Every message write MUST be paired with an `events` row of `event_type='message_sent'`.

#### Scenario: Sending a message creates paired rows

- **WHEN** `send_message({to_agent_id:'sess-B', body:'hi'})` succeeds
- **THEN** one new row appears in `messages` and exactly one new row in `events` with matching `event_id`

### Requirement: send_message requires exactly one recipient field

`send_message({to_agent_id?, to_role?, body, subject?})` MUST require either `to_agent_id` or `to_role`, but not both. If both are provided, the daemon SHALL return `{ error: 'ambiguous_recipient' }`. If neither is provided, it SHALL return `{ error: 'missing_recipient' }`.

`send_message` MUST NOT auto-poke the recipient(s).  The tool persists the message to the mailbox and returns; the recipient sees it on their next natural turn via `get_inbox`.  Callers MAY chain `poke({ target_agent_id, prompt })` immediately after a successful `send_message` to inject a wake-up prompt into the recipient's tmux pane when immediate attention is needed.  The `send_message` tool's MCP description SHOULD advise callers of this "fire-and-forget + optional poke follow-up" idiom.

#### Scenario: Both recipient fields given

- **WHEN** client calls `send_message({to_agent_id:'X', to_role:'frontend', body:'hi'})`
- **THEN** response is `{ error: 'ambiguous_recipient' }`

#### Scenario: No recipient field given

- **WHEN** client calls `send_message({body:'hi'})`
- **THEN** response is `{ error: 'missing_recipient' }`

#### Scenario: Successful send_message does not auto-poke recipient

- **GIVEN** recipient `sess-B` is registered in the same team with `tmux_pane_id='%99'`
- **WHEN** caller `sess-A` calls `send_message({to_agent_id:'sess-B', body:'hi'})`
- **THEN** the message is persisted to `messages` with a new `event_id`
- **AND** the daemon MUST NOT internally invoke the `poke` tool or any tmux command on pane `%99`
- **AND** the response shape is `{ message_id, event_id, recipients: [...] }` with no poke-related fields

#### Scenario: send_message tool description advises poke follow-up

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of the tool named `send_message`
- **THEN** the description string SHOULD reference the `poke` tool by name
- **AND** SHOULD indicate that poke is optional / for urgent delivery, not automatic

### Requirement: send_message to unknown recipient

When `to_agent_id` references no agent in the caller's team, or `to_role` matches zero agents in the team, the daemon SHALL return `{ error: 'unknown_recipient' }` without writing any event.

#### Scenario: to_agent_id does not exist

- **GIVEN** no agent with id `sess-Z` exists in team 'default'
- **WHEN** caller in team 'default' calls `send_message({to_agent_id:'sess-Z', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no new event row is created

### Requirement: send_message to role fans out to all matching agents

When `to_role` is provided, the daemon SHALL materialize one `messages` row per matching agent in the caller's team, sharing a single `event_id`. The response MUST include `{ message_id, event_id, recipients: string[] }` where `recipients` is the agent_id array.

#### Scenario: Two frontend agents in team

- **GIVEN** agents `sess-F1` and `sess-F2` both have `role='frontend'` in team 'default'
- **WHEN** caller calls `send_message({to_role:'frontend', body:'hi'})`
- **THEN** `recipients` contains `['sess-F1', 'sess-F2']` (order-insensitive)
- **AND** `messages` gains two rows with identical `event_id`

### Requirement: broadcast excludes sender

`broadcast({body, subject?})` SHALL fan-out to every agent in the caller's team except the caller itself.

#### Scenario: Sender not in recipients

- **GIVEN** team 'default' has agents `sess-A`, `sess-B`, `sess-C`
- **WHEN** `sess-A` calls `broadcast({body:'all-hands'})`
- **THEN** `recipients` contains exactly `['sess-B','sess-C']`

### Requirement: get_inbox returns messages after cursor

`get_inbox({ since_event_id?: number = 0, limit?: number = 50 })` SHALL return messages addressed to the caller (by `to_agent_id`, or by `to_role` where the caller's role matches) with `event_id > since_event_id`, ordered by `event_id` ascending, capped by `limit` (max 200). Response MUST include `{ messages, has_more, last_event_id }` where `last_event_id` is the highest returned event_id (or `since_event_id` if none).

#### Scenario: Initial inbox with default cursor

- **GIVEN** five messages addressed to caller with event_ids 10, 20, 30, 40, 50
- **WHEN** caller calls `get_inbox({})`
- **THEN** response contains the five messages
- **AND** `last_event_id === 50`
- **AND** `has_more === false`

#### Scenario: Cursor-based pagination has_more

- **GIVEN** 120 messages addressed to caller
- **WHEN** caller calls `get_inbox({ since_event_id: 0, limit: 50 })`
- **THEN** returned messages count is 50
- **AND** `has_more === true`

### Requirement: Offline delivery via events outbox

Messages addressed to an agent that is currently offline SHALL be persisted in `events` and `messages` as usual. When the agent reconnects and calls `get_inbox({since_event_id: <its stored cursor>})`, it SHALL receive those messages.

#### Scenario: Message while offline, fetched after reconnect

- **GIVEN** agent `sess-A` is currently disconnected with stored cursor 5
- **WHEN** agent `sess-B` sends a message to `sess-A` creating event 6
- **AND** `sess-A` reconnects and calls `get_inbox({since_event_id: 5})`
- **THEN** the message is returned

### Requirement: Fire-and-forget delivery contract for send_message and broadcast

`send_message` MUST follow a fire-and-forget delivery contract regarding event-outbox semantics:

1. The tool MUST persist to the mailbox (and event outbox) and return synchronously (modulo the optional auto-poke quiet-guard window).
2. The tool's MCP description MUST advise callers that `auto_poke` is the default and may be opted out via `auto_poke:false`.

This Requirement applies to `send_message` only. `broadcast` is governed by the separate `Broadcast auto-poke default with parallel fan-out` Requirement, which mandates auto-poke as default rather than fire-and-forget. The header retains "and broadcast" for historical continuity with the Requirement introduced by `add-auto-poke-on-send`; the body of this Requirement SHALL be read as authoritative over the header text — `broadcast` is explicitly carved out.

#### Scenario: send_message with auto_poke:false is pure fire-and-forget

- **GIVEN** recipient `sess-B` has a valid `tmux_pane_id` registered
- **WHEN** caller `sess-A` calls `send_message({to_agent_id:'sess-B', body:'any', auto_poke:false})`
- **THEN** no `poke` entry, no tmux-injection event, no side effect beyond mailbox persistence occurs

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

### Requirement: Broadcast auto-poke default with parallel fan-out

`broadcast` MUST accept an optional `auto_poke: boolean` parameter. When omitted, the default MUST be `true` (matching `send_message` behavior). When the caller explicitly passes `auto_poke: false`, the daemon MUST persist the message to every recipient's mailbox and skip all guard / poke / retry logic; the response MUST have `poked: false`, omit `poke_skip_reasons`, and have `retry_scheduled: false`.

When `auto_poke` resolves to `true`, the daemon MUST:

1. Persist the message to every recipient's mailbox (one row per recipient sharing one `event_id`).
2. For every recipient, in parallel via `Promise.all`, run the same quiet-guard logic specified in `Send-message auto-poke default with quiet-guard`:
   - If recipient has no `tmux_pane_id`: skip with reason `no_pane`.
   - If `tmux` not on PATH: skip with reason `tmux_unavailable`.
   - If recipient is the caller: skip with reason `self` (broadcast already excludes sender, but defensive).
   - Otherwise capture pane tail, wait `POKE_QUIET_MS`, recapture, compare. Match → fire poke; differ → skip with reason `guard_failed`.
3. For every recipient that resulted in `guard_failed` AND has a `tmux_pane_id`, schedule the same 3-attempt retry-with-backoff (30s / 180s / 600s) specified in `Auto-poke retry with backoff on guard_failed`.
4. The total wall-clock duration MUST approximate one `POKE_QUIET_MS` window (~2000ms default), not `N × POKE_QUIET_MS`, because guards run in parallel.

The `broadcast` response MUST include:

- `poked: boolean` — `true` iff at least one recipient was successfully poked.
- `poke_skip_reasons?: Array<{ agent_id: string; reason: 'no_pane' | 'guard_failed' | 'tmux_unavailable' | 'self' }>` — one entry per recipient that was attempted but skipped. Absent when `auto_poke` resolves to `false`.
- `retry_scheduled: boolean` — `true` iff at least one recipient was queued for retry.
- `retry_delays_s?: number[]` — equals `[30, 180, 600]` when `retry_scheduled` is `true`; absent otherwise.

The `broadcast` MCP tool description MUST state that auto-poke is the default and that callers may opt out via `auto_poke:false`.

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
- **AND** response `poked: false`
- **AND** `poke_skip_reasons` is absent
- **AND** `retry_scheduled: false`, `retry_delays_s` absent
- **AND** no `tmux capture-pane` or `send-keys` command was issued for B or C

#### Scenario: Broadcast tool description states default-on with opt-out

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of the tool named `broadcast`
- **THEN** the description string SHOULD state that auto-poke is the default
- **AND** SHOULD reference `auto_poke:false` as the opt-out parameter
- **AND** SHOULD describe the quiet-guard + retry-backoff behavior consistent with send_message

#### Scenario: Default broadcast with active panes schedules retries identical to send_message

- **GIVEN** team has A, B, C with `tmux_pane_id`
- **AND** B and C panes both active (guard fails for both), `POKE_QUIET_MS=50`
- **WHEN** A calls `broadcast({body:'urgent'})` (auto_poke omitted)
- **THEN** B and C have the message in mailbox
- **AND** response `poked: false`
- **AND** `poke_skip_reasons` contains both `{B, guard_failed}` and `{C, guard_failed}`
- **AND** `retry_scheduled: true`, `retry_delays_s: [30, 180, 600]`
- **AND** the daemon's internal retry map has 2 entries (one per recipient)

### Requirement: Auto-poke prompt is a wake-up hint, not the message body

When `send_message` or `broadcast` triggers the internal auto-poke path (either during the initial fan-out or in any retry tick scheduled by the guard_failed backoff), the prompt injected into the recipient's tmux pane MUST be a short wake-up hint that identifies the sender and points the recipient at `get_inbox`. The prompt MUST NOT contain any substring of the message `body` the caller passed to `send_message` or `broadcast`.

The prompt format MUST be:

```
新邮件 from {sender_identifier}, 请调 get_inbox 查看
```

Where `sender_identifier` is:

- `{display_name} ({agent_id})` when the sender agent has a non-empty `display_name` in the `agents` table
- `{agent_id[:8]}` when `display_name` is `null`, empty, or the agent row cannot be resolved (defensive fallback)

The total prompt length MUST NOT exceed 200 characters — this is the same soft cap established by the clarified `poke` tool description (commit `2ec2e7c`). The fixed wording above already fits comfortably under that cap.

The rule applies to every poke issued by the daemon via the `autoPokeImpl` path, including:

1. Initial poke fired during `send_message` auto-poke (single recipient or `to_role` fan-out).
2. Initial poke fired during `broadcast` auto-poke fan-out.
3. Retry pokes fired by `poke-retry.ts` ticks after a prior `guard_failed`.

The rule does NOT constrain the `poke` MCP tool itself when callers invoke it directly — that remains the caller's responsibility (per the clarified `poke` tool description).

This Requirement guarantees that message bodies flow exclusively through the mailbox and are only readable via `get_inbox`, preserving the "poke is a wake-up hint, not a content channel" contract established by commit `2ec2e7c`.

#### Scenario: send_message auto-poke injects hint, not body

- **GIVEN** agents A (display_name="lead-opus") and B (display_name="worker-kimi") are registered in the same team, both with `tmux_pane_id`
- **AND** B's pane is idle, `POKE_QUIET_MS=100`
- **WHEN** A calls `send_message({to_agent_id: B, body: "please investigate bug #42 in the auth module"})` with default auto_poke
- **THEN** the message is persisted to B's mailbox with the full body
- **AND** the poke prompt injected into B's pane equals `"新邮件 from lead-opus (<A's agent_id>), 请调 get_inbox 查看"`
- **AND** the injected prompt does NOT contain the substring `"bug #42"` or any other substring of the body

#### Scenario: broadcast auto-poke fan-out uses identical hint format per recipient

- **GIVEN** sender A (display_name="captain"), recipients B and C (both with `tmux_pane_id`, both idle panes)
- **AND** `POKE_QUIET_MS=100`
- **WHEN** A calls `broadcast({body: "sensitive config: API_KEY=sk-xyz"})` with default auto_poke
- **THEN** the message is persisted for B and C
- **AND** B's pane receives prompt `"新邮件 from captain (<A's agent_id>), 请调 get_inbox 查看"`
- **AND** C's pane receives an identical-format prompt (same template, same sender identifier)
- **AND** neither pane's prompt contains `"API_KEY"`, `"sk-xyz"`, or any other substring of the body

#### Scenario: Retry tick reuses hint format, not the captured body

- **GIVEN** agent A sends `send_message` to B whose pane is active (guard fails) → retry scheduled
- **AND** 30 seconds later B's pane becomes idle, the first retry tick fires and guard passes
- **WHEN** the retry fires the poke via `autoPokeImpl`
- **THEN** the poke prompt is the hint format `"新邮件 from {A.display_name} (<A's agent_id>), 请调 get_inbox 查看"`, NOT the original `send_message` body

#### Scenario: Sender without display_name falls back to agent_id[:8]

- **GIVEN** sender A is registered with `display_name = null` and `agent_id = "abc12345-6789-..."` (UUID)
- **AND** recipient B is idle
- **WHEN** A calls `send_message({to_agent_id: B, body: "anything"})` with default auto_poke
- **THEN** the poke prompt equals `"新邮件 from abc12345, 请调 get_inbox 查看"` (using the first 8 characters of `agent_id`)
- **AND** the prompt does NOT contain "null" or the substring "anything"

#### Scenario: send_message and broadcast tool descriptions document the hint-only contract

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of `send_message` or `broadcast`
- **THEN** each description SHOULD state that auto-poke injects only a short wake-up hint (e.g. "only injects a SHORT wake-up hint" or "短提醒") and NOT the message body
- **AND** each description SHOULD reference `get_inbox` as the retrieval path for the body

### Requirement: poke dispatches via transport abstraction

`poke({target_agent_id, prompt})` SHALL perform transport selection and fallback as follows:

1. Look up the target row: `SELECT channel_session_id, tmux_pane_id, team FROM agents WHERE agent_id = ?`.
2. If the target does not exist, return `{error: 'unknown_target'}`.
3. Self-poke and cross-team checks remain unchanged; `allowCrossTeam` internal flag still governs auto-poke bypass.
4. If `channel_session_id` is non-null AND the daemon's `ChannelWakeFanout` has a live sink attached for that id, call the internal `sendChannelWake(channel_session_id, {content, meta})` with a wake-up hint plus sender / team / latest_event metadata.  On success, return `{ok: true, transport_used: 'claude-channel', channel_session_id}`.
5. If step 4 did not run (no csid OR no sink) OR returned `{ok: false}`, AND `tmux_pane_id` is non-null, perform the existing tmux-based poke flow.  On success, return `{ok: true, pane_id, pane_tail_before, pane_tail_after, transport_used: 'tmux-poke'}`.  On tmux error, return the classified error with `transport_used: 'tmux-poke'`.
6. If neither transport is available, return `{error: 'no_transport_available', detail: {channel_subscribed: <bool>, tmux_pane_set: <bool>}}`.

The tool MUST NOT fan a wake-up via both transports for a single poke call — successful channel delivery short-circuits tmux delivery.

#### Scenario: poke prefers claude-channel transport when csid set and proxy online

- **GIVEN** target agent `bob` has `channel_session_id='csid-bob'` and `tmux_pane_id='%99'`
- **AND** the channel proxy subscribing to `csid-bob` is online (sink attached in ChannelWakeFanout)
- **WHEN** `alice` (same team) calls `poke({target_agent_id: 'bob', prompt: 'p'})`
- **THEN** the response is `{ok: true, transport_used: 'claude-channel', channel_session_id: 'csid-bob'}`
- **AND** no `tmux` command is executed against pane `%99`

#### Scenario: poke falls back to tmux when channel proxy sink absent

- **GIVEN** target `bob` has `channel_session_id='csid-bob'` and `tmux_pane_id='%99'`
- **AND** no sink is attached for `csid-bob` in ChannelWakeFanout
- **WHEN** `alice` calls `poke({target_agent_id: 'bob', prompt: 'p'})`
- **THEN** the daemon executes the tmux paste-then-enter flow on pane `%99`
- **AND** the response is `{ok: true, transport_used: 'tmux-poke', pane_id: '%99', pane_tail_before: ..., pane_tail_after: ...}`

#### Scenario: poke returns no_transport_available when neither transport configured

- **GIVEN** target `bob` has `channel_session_id=NULL` and `tmux_pane_id=NULL`
- **WHEN** `alice` calls `poke({target_agent_id: 'bob', prompt: 'p'})`
- **THEN** the response is `{error: 'no_transport_available', detail: {channel_subscribed: false, tmux_pane_set: false}}`
- **AND** no tmux command is executed

#### Scenario: poke response envelope carries transport_used on success

- **GIVEN** any poke call that succeeds via either transport
- **WHEN** the response envelope is inspected
- **THEN** the envelope contains a `transport_used` field whose value is either `'claude-channel'` or `'tmux-poke'`

