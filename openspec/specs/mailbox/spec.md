# mailbox Specification

## Purpose

Deliver direct and role-based messages between agents in the same team, persisting through offline periods via the events outbox and cursor-based inbox polling.
## Requirements
### Requirement: Messages table schema and event projection

The database SHALL contain a `messages` table: `id TEXT PRIMARY KEY`, `event_id INTEGER NOT NULL REFERENCES events(event_id)`, `from_team TEXT NOT NULL`, `to_team TEXT NOT NULL`, `from_agent_id TEXT NOT NULL`, `to_agent_id TEXT`, `to_role TEXT`, `subject TEXT`, `body TEXT NOT NULL`, `need_reply INTEGER NOT NULL DEFAULT 1`, `sent_at TEXT NOT NULL`. Every message write MUST be paired with an `events` row of `event_type='message_sent'`, and that events row's `from_team` / `to_team` MUST equal the message row's `from_team` / `to_team` respectively.

For same-team writes (`broadcast`, `broadcast_to_role`, same-team `send_message`), `from_team` MUST equal `to_team`. For cross-team `send_message`, `from_team` and `to_team` MAY differ.

#### Scenario: Sending a same-team message creates paired rows with equal team fields

- **WHEN** `send_message({to_agent_id:'sess-B', body:'hi'})` succeeds with sender in team `alpha`
- **THEN** one new row appears in `messages` with `from_team='alpha'` and `to_team='alpha'`
- **AND** exactly one new row in `events` with matching `event_id` and `from_team='alpha'`, `to_team='alpha'`

#### Scenario: Sending a cross-team message records distinct team fields

- **WHEN** `send_message({to_agent_id:'sess-B', to_team:'beta', body:'hi'})` succeeds with sender in team `alpha` and recipient `sess-B` genuinely in team `beta`
- **THEN** the new `messages` row has `from_team='alpha'`, `to_team='beta'`
- **AND** the paired `events` row has `from_team='alpha'`, `to_team='beta'`

#### Scenario: messages table exposes need_reply

- **WHEN** the daemon applies the storage schema
- **THEN** the `messages` table contains a `need_reply` column
- **AND** the column is `NOT NULL`
- **AND** the column default is `1`

### Requirement: send_message to unknown recipient

When the supplied recipient cannot be resolved, the daemon SHALL return `{ error: 'unknown_recipient' }` without writing any event. "Cannot be resolved" means:

- If the caller provided `to_agent_id`: no row in `agents` has that `agent_id`, OR the row's `team` field does not equal the resolved `to_team` (caller's team if `to_team` omitted, or the explicit `to_team` if provided).
- If the caller provided `to_agent_name`: `AgentsRepo.findByIdentity({ team: resolved_to_team, name: to_agent_name })` returns `undefined` — i.e. no row in `agents` has the matching `(team, name)` pair for the resolved team.

#### Scenario: to_agent_id does not exist

- **GIVEN** no agent with id `uuid-Z` exists
- **WHEN** caller in team 'default' calls `send_message({to_agent_id:'uuid-Z', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no new event row is created

#### Scenario: to_agent_name does not exist in resolved team

- **GIVEN** no agent with `name='ghost'` exists in team 'default'
- **WHEN** caller in team 'default' calls `send_message({to_agent_name:'ghost', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no new event row is created

#### Scenario: to_agent_name exists in caller team but explicit to_team points elsewhere

- **GIVEN** agent `bob` exists in team 'alpha' only; caller is in team 'alpha'
- **WHEN** caller calls `send_message({to_agent_name:'bob', to_team:'beta', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }` (resolved_to_team='beta' has no `bob`)
- **AND** no new event row is created

#### Scenario: to_agent_id exists but resolved to_team does not match

- **GIVEN** agent `sess-B` is in team `beta`, caller is in team `alpha`, call omits `to_team` (so resolved `to_team='alpha'`)
- **WHEN** caller calls `send_message({to_agent_id:'sess-B', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no new event row is created

### Requirement: broadcast excludes sender

`broadcast({body, subject?, auto_poke?})` SHALL fan-out to every agent in the caller's team except the caller itself. `broadcast` MUST NOT accept any `to_team`, `to_role`, or `to_agent_id` parameter — it is strictly "same-team, all members except sender".

For every recipient, the persisted `messages` row MUST have `from_team` and `to_team` both equal to the caller's team. The paired `events` row MUST have equal `from_team` / `to_team` values.

#### Scenario: Sender not in recipients

- **GIVEN** team `default` has agents `sess-A`, `sess-B`, `sess-C`
- **WHEN** `sess-A` calls `broadcast({body:'all-hands'})`
- **THEN** `recipients` contains exactly `['sess-B','sess-C']`
- **AND** all resulting messages rows have `from_team=to_team='default'`

### Requirement: get_inbox returns messages after cursor

`get_inbox({ since_event_id?: number = 0, limit?: number = 50 })` SHALL return messages addressed to the caller (by `to_agent_id`, or by `to_role` where the caller's role matches) with `to_team = caller.team` and `event_id > since_event_id`, ordered by `event_id` ascending, capped by `limit` (max 200). Response MUST include `{ messages, has_more, last_event_id }` where `last_event_id` is the highest returned event_id (or `since_event_id` if none). Each returned message MUST include `need_reply: boolean`.

Cross-team messages are delivered to the recipient's inbox normally, because the cross-team `send_message` writes the recipient's team as `to_team`.

#### Scenario: Initial inbox with default cursor

- **GIVEN** five messages addressed to caller (all in caller's team) with event_ids 10, 20, 30, 40, 50
- **WHEN** caller calls `get_inbox({})`
- **THEN** response contains the five messages
- **AND** `last_event_id === 50`
- **AND** `has_more === false`

#### Scenario: Cursor-based pagination has_more

- **GIVEN** 120 messages addressed to caller
- **WHEN** caller calls `get_inbox({ since_event_id: 0, limit: 50 })`
- **THEN** returned messages count is 50
- **AND** `has_more === true`

#### Scenario: Cross-team messages appear in recipient's inbox

- **GIVEN** caller `sess-B` is in team `beta`
- **AND** agent `sess-A` in team `alpha` sends `send_message({to_agent_id:'sess-B', to_team:'beta', body:'cross-team'})`, producing event id 42
- **WHEN** `sess-B` calls `get_inbox({since_event_id: 41})`
- **THEN** the response includes the message with `from_agent_id='sess-A'`, `from_team='alpha'`, `to_team='beta'`

#### Scenario: Inbox exposes reply expectation

- **GIVEN** agent `sess-A` sends `send_message({to_agent_id:'sess-B', body:'FYI', need_reply:false, auto_poke:false})`
- **WHEN** `sess-B` calls `get_inbox({since_event_id: 0})`
- **THEN** the returned message has `need_reply=false`

### Requirement: Offline delivery via events outbox

Messages addressed to an agent that is currently offline SHALL be persisted in `events` and `messages` as usual. When the agent reconnects and calls `get_inbox({since_event_id: <its stored cursor>})`, it SHALL receive those messages.

This contract applies to same-team and cross-team messages alike.

#### Scenario: Message while offline, fetched after reconnect

- **GIVEN** agent `sess-A` is currently disconnected with stored cursor 5
- **WHEN** agent `sess-B` sends a message to `sess-A` creating event 6
- **AND** `sess-A` reconnects and calls `get_inbox({since_event_id: 5})`
- **THEN** the message is returned

### Requirement: Fire-and-forget delivery contract for send_message and broadcast

`send_message` MUST follow a fire-and-forget delivery contract regarding event-outbox semantics:

1. The tool MUST persist to the mailbox (and event outbox) and return synchronously (modulo the optional auto-poke quiet-guard window).
2. The tool's MCP description MUST advise callers that `auto_poke` is the default and may be opted out via `auto_poke:false`.

This Requirement applies to `send_message` only. `broadcast` and `broadcast_to_role` are governed by their own "auto-poke default with parallel fan-out" Requirements, which mandate auto-poke as default rather than fire-and-forget.

#### Scenario: send_message with auto_poke:false is pure fire-and-forget

- **GIVEN** recipient `sess-B` has a valid `tmux_pane_id` registered in caller's team
- **WHEN** caller `sess-A` calls `send_message({to_agent_id:'sess-B', body:'any', auto_poke:false})`
- **THEN** no `poke` entry, no tmux-injection event, no side effect beyond mailbox persistence occurs

### Requirement: Auto-poke retry with backoff on guard_failed

When the initial auto-poke guard returns `guard_failed` for a recipient that has a registered `tmux_pane_id`, the daemon MUST schedule up to three background retries with fixed delays: 30 seconds, 180 seconds (3 minutes), and 600 seconds (10 minutes).  Retries MUST NOT be scheduled for recipients whose skip reason is `no_pane`, `self`, or `tmux_unavailable` — only `guard_failed`.

This Requirement applies uniformly to `send_message` (including cross-team), `broadcast`, and `broadcast_to_role`.

Each retry tick MUST:

1. Look up the recipient's current `tmux_pane_id` and `last_seen_at` from the database (no team filter — `agent_id` is globally unique).
2. If the recipient no longer exists or has no pane id: silently stop retrying for that recipient.
3. If `last_seen_at > sent_at` of the originating message: silently stop retrying.
4. Otherwise: invoke `runQuietGuard(pane_id)`.  Pass → fire poke with the hint-format wake-up prompt; stop remaining retries.  Fail → skip this attempt; schedule the next retry in the sequence if any remaining.

The sending tool's response (`send_message`, `broadcast`, or `broadcast_to_role`) MUST include:

- `retry_scheduled: boolean` — `true` iff the daemon scheduled at least one retry for any recipient.
- `retry_delays_s?: number[]` — the backoff sequence used (MUST equal `[30, 180, 600]` when `retry_scheduled` is `true`; MAY be absent when `false`).

The daemon MUST clear all pending retry timers on shutdown (e.g. Fastify `onClose` hook) to avoid leaking timer handles.  Retry outcomes MUST NOT write new events or messages back to the sender.

#### Scenario: Guard_failed recipient schedules 3 retries

- **GIVEN** A and B registered with `tmux_pane_id`, same team, B's pane active, `POKE_QUIET_MS=50`
- **WHEN** A calls `send_message({ to_agent_id: B, body: "hi" })`
- **THEN** response has `poked: false`, `poke_skip_reasons: [{ agent_id: B, reason: 'guard_failed' }]`
- **AND** response has `retry_scheduled: true`, `retry_delays_s: [30, 180, 600]`
- **AND** the daemon's internal retry map has exactly one entry keyed by `${message_id}:${B}`

#### Scenario: First retry tick guard passes → poke fires, remaining cancelled

- **GIVEN** the setup above with a retry already scheduled, pointer to attempt 1
- **AND** test uses fake timers, B's pane becomes idle (guard will pass on re-check)
- **WHEN** 30 seconds of fake-time advance
- **THEN** a poke is fired at B's pane
- **AND** the retry map has no entry for this message/recipient
- **AND** no further timers fire

#### Scenario: Cross-team send_message guard_failed also schedules retries

- **GIVEN** A in team `alpha` and B in team `beta`, both with `tmux_pane_id`, B's pane active, `POKE_QUIET_MS=50`
- **WHEN** A calls `send_message({to_agent_id: B, to_team: 'beta', body: "hi"})`
- **THEN** response has `retry_scheduled: true`, `retry_delays_s: [30, 180, 600]`
- **AND** retry map has one entry keyed by `${message_id}:${B}`
- **AND** on subsequent retry tick, the lookup for B's `tmux_pane_id` succeeds via global `agent_id` match (no team filter in the retry lookup)

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
- **AND** the message row in `messages` table for B is intact

#### Scenario: no_pane recipient does NOT get retry

- **GIVEN** A registered with `tmux_pane_id`, B registered WITHOUT `tmux_pane_id`, same team
- **WHEN** A calls `send_message({ to_agent_id: B, body: "hi" })`
- **THEN** response has `poked: false`, `poke_skip_reasons: [{ agent_id: B, reason: 'no_pane' }]`
- **AND** response has `retry_scheduled: false`, `retry_delays_s` absent, retry map empty

#### Scenario: Fan-out with mixed outcomes — only guard_failed recipients get retries

- **GIVEN** A, B (idle pane), C (active pane), D (no pane_id), all on same team, all role='worker'; `POKE_QUIET_MS=50`
- **WHEN** A calls `broadcast_to_role({ to_role: 'worker', body: "hi" })`
- **THEN** B is poked immediately (no retry scheduled for B)
- **AND** C's skip reason is `guard_failed`, C has a retry scheduled
- **AND** D's skip reason is `no_pane`, D has NO retry scheduled
- **AND** response has `retry_scheduled: true`, `retry_delays_s: [30, 180, 600]`
- **AND** retry map has exactly one entry keyed by C

#### Scenario: Shutdown clears all pending retry timers

- **GIVEN** at least one retry scheduled
- **WHEN** the daemon's Fastify `app.close()` is called
- **THEN** the retry map is empty
- **AND** no timer fires after shutdown even as fake-time advances further

### Requirement: Send-message auto-poke default with quiet-guard

`send_message` MUST accept an optional `auto_poke: boolean` parameter.  When the parameter is omitted, the default value MUST be `true` — for same-team AND cross-team calls alike.

When `auto_poke` resolves to `true`, the daemon MUST run a quiet-guard before firing `poke` against the single recipient:

1. Capture the recipient's pane tail via `tmux capture-pane` (if `tmux_pane_id` is registered).
2. Wait `POKE_QUIET_MS` milliseconds (default 2000, overridable via environment variable, positive integer).
3. Re-capture the pane tail and compare the two captures (string-equal or equivalent hash).
4. If the captures match (pane has been idle): fire the poke.
5. If the captures differ (pane has activity): skip the poke; the message MUST still be persisted in the mailbox.

The daemon MUST skip the poke and record a skip reason when any of the following apply: the recipient has no registered `tmux_pane_id` (reason `no_pane`), `tmux` is not available on PATH (reason `tmux_unavailable`), the quiet-guard detects activity (reason `guard_failed`), or the recipient is the caller itself (reason `self`).

The `send_message` response MUST include:

- `message_id, event_id, recipients: string[]` (recipients has length exactly 1 when successful)
- `poked: boolean` — `true` iff the intended recipient was successfully poked.
- `poke_skip_reasons?: Array<{ agent_id: string; reason: 'no_pane' | 'guard_failed' | 'tmux_unavailable' | 'self' }>` — present with one entry when the poke was skipped.  Absent when `auto_poke` resolves to `false`.

When the caller provides `auto_poke: false` explicitly, the daemon MUST NOT invoke poke or the guard; the response MUST have `poked: false` and omit `poke_skip_reasons`.

Cross-team auto-poke is identical: the recipient's `tmux_pane_id` is looked up by `agent_id` alone (since agent_id is globally unique), and the poke is injected into that pane.

#### Scenario: Single recipient same-team, idle pane, default triggers poke

- **GIVEN** agent A and agent B are registered with `tmux_pane_id` values on the same team
- **AND** agent B's tmux pane has been idle, `POKE_QUIET_MS=100` for test speed
- **WHEN** agent A calls `send_message({ to_agent_id: B, body: "hi" })` (auto_poke omitted)
- **THEN** the message is persisted in B's mailbox with `from_team=to_team`
- **AND** the response has `poked: true`
- **AND** B's tmux pane has received the poke injection

#### Scenario: Cross-team auto-poke fires when recipient pane idle

- **GIVEN** agent A in team `alpha` and agent B in team `beta`, both with `tmux_pane_id`
- **AND** B's pane idle, `POKE_QUIET_MS=100`
- **WHEN** A calls `send_message({to_agent_id: B, to_team: 'beta', body: "hi"})` (auto_poke omitted)
- **THEN** the message is persisted with `from_team='alpha', to_team='beta'`
- **AND** the response has `poked: true`
- **AND** B's pane received the poke injection

#### Scenario: Recipient's pane is active, guard fails, falls back to mailbox

- **GIVEN** agent A and B same team, both with `tmux_pane_id`, B's pane actively outputting, `POKE_QUIET_MS=100`
- **WHEN** A calls `send_message({to_agent_id: B, body:"hi"})`
- **THEN** the message is persisted
- **AND** response `poked: false` with `poke_skip_reasons` containing `{agent_id: B, reason: 'guard_failed'}`

#### Scenario: Recipient has no tmux_pane_id

- **GIVEN** B registered without `tmux_pane_id` (same or cross team)
- **WHEN** A calls `send_message({to_agent_id: B, ...})`
- **THEN** response `poked: false` with `poke_skip_reasons` containing `{agent_id: B, reason: 'no_pane'}`

#### Scenario: auto_poke:false disables the behavior entirely

- **GIVEN** A and B both registered with tmux pane ids, idle pane
- **WHEN** A calls `send_message({to_agent_id: B, body: "hi", auto_poke: false})`
- **THEN** the message persists, response `poked: false`, `poke_skip_reasons` absent, B's pane NOT injected

#### Scenario: Invalid POKE_QUIET_MS env falls back to default

- **GIVEN** `process.env.POKE_QUIET_MS = 'not-a-number'`
- **WHEN** daemon boots and handles an auto-poke send_message
- **THEN** the quiet window is 2000ms (default) and the daemon does not crash

### Requirement: Broadcast auto-poke default with parallel fan-out

`broadcast` MUST accept an optional `auto_poke: boolean` parameter. When omitted, the default MUST be `true` (matching `send_message` behavior). When the caller explicitly passes `auto_poke: false`, the daemon MUST persist the message to every recipient's mailbox and skip all guard / poke / retry logic; the response MUST have `poked: false`, omit `poke_skip_reasons`, and have `retry_scheduled: false`.

When `auto_poke` resolves to `true`, the daemon MUST:

1. Persist the message to every recipient's mailbox (one row per recipient sharing one `event_id`, all with `from_team=to_team=caller.team`).
2. For every recipient, in parallel via `Promise.all`, run the quiet-guard logic specified in "Send-message auto-poke default with quiet-guard":
   - If recipient has no `tmux_pane_id`: skip with reason `no_pane`.
   - If `tmux` not on PATH: skip with reason `tmux_unavailable`.
   - If recipient is the caller: skip with reason `self` (broadcast already excludes sender, but defensive).
   - Otherwise capture pane tail, wait `POKE_QUIET_MS`, recapture, compare. Match → fire poke; differ → skip with reason `guard_failed`.
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

### Requirement: Auto-poke prompt is a wake-up hint, not the message body

When `send_message`, `broadcast`, or `broadcast_to_role` triggers the internal auto-poke path (either during the initial fan-out or in any retry tick scheduled by the guard_failed backoff), the prompt injected into the recipient's tmux pane MUST be a short wake-up hint that identifies the sender and points the recipient at `get_inbox`. The prompt MUST NOT contain any substring of the message `body` the caller passed.

The prompt format MUST be:

```
新邮件 from {sender_identifier}, 请调 get_inbox 查看
```

Where `sender_identifier` is:

- `{display_name} ({agent_id})` when the sender agent has a non-empty `display_name` in the `agents` table
- `{agent_id[:8]}` when `display_name` is `null`, empty, or the agent row cannot be resolved (defensive fallback)

For cross-team `send_message`, the sender_identifier is looked up by `from_agent_id` regardless of team — no team prefix is added to the hint (recipient can inspect `from_team` via `get_inbox`).

The total prompt length MUST NOT exceed 200 characters.

The rule applies to every poke issued by the daemon via the `autoPokeImpl` path, including:

1. Initial poke fired during `send_message` auto-poke (same team or cross team, single recipient).
2. Initial poke fired during `broadcast` auto-poke fan-out.
3. Initial poke fired during `broadcast_to_role` auto-poke fan-out.
4. Retry pokes fired by `poke-retry.ts` ticks after a prior `guard_failed`.

The rule does NOT constrain the `poke` MCP tool itself when callers invoke it directly.

#### Scenario: send_message auto-poke injects hint, not body (same team)

- **GIVEN** agents A (display_name="lead-opus") and B (display_name="worker-kimi") are registered in the same team, both with `tmux_pane_id`
- **AND** B's pane is idle, `POKE_QUIET_MS=100`
- **WHEN** A calls `send_message({to_agent_id: B, body: "please investigate bug #42 in the auth module"})` with default auto_poke
- **THEN** the message is persisted to B's mailbox with the full body
- **AND** the poke prompt injected into B's pane equals `"新邮件 from lead-opus (<A's agent_id>), 请调 get_inbox 查看"`
- **AND** the injected prompt does NOT contain `"bug #42"` or any other substring of the body

#### Scenario: Cross-team send_message auto-poke uses same hint format (no team prefix)

- **GIVEN** agent A (display_name="lead-alpha") in team `alpha`, agent B in team `beta` with idle pane
- **WHEN** A calls `send_message({to_agent_id: B, to_team: 'beta', body: "secret: token=xyz"})` with default auto_poke
- **THEN** B's pane receives exactly `"新邮件 from lead-alpha (<A's agent_id>), 请调 get_inbox 查看"`
- **AND** the prompt does NOT contain `"alpha"` or `"token"` or any body substring

#### Scenario: broadcast_to_role auto-poke uses identical hint format per recipient

- **GIVEN** sender A (display_name="captain"), recipients B and C in same team with role `backend`, both with `tmux_pane_id` and idle panes, `POKE_QUIET_MS=100`
- **WHEN** A calls `broadcast_to_role({to_role: 'backend', body: "sensitive config: API_KEY=sk-xyz"})` with default auto_poke
- **THEN** both B and C have the message in mailbox
- **AND** B's pane receives `"新邮件 from captain (<A's agent_id>), 请调 get_inbox 查看"`
- **AND** C's pane receives an identical-format prompt with the same sender identifier
- **AND** neither pane contains `"API_KEY"`, `"sk-xyz"`, or any body substring

#### Scenario: Retry tick reuses hint format, not the captured body

- **GIVEN** agent A sends `send_message` to B whose pane is active (guard fails) → retry scheduled
- **AND** 30 seconds later B's pane becomes idle, the first retry tick fires and guard passes
- **WHEN** the retry fires the poke via `autoPokeImpl`
- **THEN** the poke prompt is the hint format `"新邮件 from {A.display_name} (<A's agent_id>), 请调 get_inbox 查看"`, NOT the original body

#### Scenario: Sender without display_name falls back to agent_id[:8]

- **GIVEN** sender A registered with `display_name = null` and `agent_id = "abc12345-6789-..."`, recipient B idle
- **WHEN** A calls `send_message({to_agent_id: B, body: "anything"})` with default auto_poke
- **THEN** the poke prompt equals `"新邮件 from abc12345, 请调 get_inbox 查看"`

#### Scenario: All three tools' descriptions document the hint-only contract

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of `send_message`, `broadcast`, and `broadcast_to_role`
- **THEN** each description SHOULD state that auto-poke injects only a short wake-up hint (e.g. "only injects a SHORT wake-up hint" or "短提醒") and NOT the message body
- **AND** each description SHOULD reference `get_inbox` as the retrieval path

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

### Requirement: Fan-out routing skips offline recipients

When `send_message` uses `to_role` (role-based fan-out) or `broadcast` enumerates team members, the daemon MUST restrict the recipient set to agents whose `last_seen_at` is within the configured online window (`ONLINE_MS`, currently `5 * 60 * 1000` ms = 5 minutes, sourced from `src/storage/agents-repo.ts`). Agents whose `last_seen_at` is older than `now - ONLINE_MS` MUST be excluded from the recipient list entirely — they receive no mailbox entry, no event, no auto-poke attempt, and no retry scheduling.

This Requirement applies to the following fan-out paths ONLY:

1. `send_message({ to_role })` — select agents by role + team.
2. `broadcast({ body })` — select all other agents in the caller's team.

This Requirement does NOT apply to:

- `send_message({ to_agent_id })` — direct single-recipient sends. They proceed exactly as before, addressing the agent by id regardless of online status. The `Offline delivery via events outbox` Requirement remains authoritative for direct sends.
- `list_agents` — still returns every row in the team, including offline agents, with an `online: boolean` field for diagnosis. This preserves debugging visibility into ghost accumulation.

When fan-out filtering results in an empty recipient list (e.g. role exists but no agent under it is currently online; broadcast team has only offline agents besides sender), the daemon SHALL return `{ error: "unknown_recipient" }` — the same error shape already used for "no matching recipients" cases. No new error code is introduced.

The online threshold uses `last_seen_at` which is refreshed on every MCP tool call that goes through `touchIfRegistered` (see `src/mcp/tools.ts` `touchIfRegistered`). Idle-but-live agents keep themselves online via their own normal tool activity; no explicit keepalive is required.

#### Scenario: Broadcast skips offline recipients in fan-out

- **GIVEN** team "default" has agents A (sender, `last_seen_at = now`), B (`last_seen_at = now - 1 min`), C (`last_seen_at = now - 10 min`, offline), D (`last_seen_at = now - 30 sec`)
- **WHEN** A calls `broadcast({ body: "status update" })`
- **THEN** the response `recipients` array contains exactly `[B, D]` (order-insensitive) — C is excluded
- **AND** C has no new row in `messages` created by this broadcast
- **AND** no `tmux capture-pane` or poke injection is attempted against C's pane
- **AND** no retry is scheduled for C

#### Scenario: send_message to_role excludes offline agents

- **GIVEN** team "default" has agents F1 (`role=frontend`, `last_seen_at = now - 1 min`), F2 (`role=frontend`, `last_seen_at = now - 2 hours`, offline), F3 (`role=frontend`, `last_seen_at = now`)
- **WHEN** A calls `send_message({ to_role: 'frontend', body: "hi frontends" })`
- **THEN** `recipients` contains exactly `[F1, F3]`
- **AND** F2 has no mailbox entry for this event
- **AND** the event_id row in `events` has `payload.recipients = [F1, F3]`

#### Scenario: send_message to_agent_id unaffected by online filter

- **GIVEN** recipient B is registered with `last_seen_at = now - 3 hours` (offline)
- **WHEN** caller A calls `send_message({ to_agent_id: B, body: "direct ping" })`
- **THEN** the message IS persisted to B's mailbox (honoring the existing `Offline delivery via events outbox` Requirement)
- **AND** `recipients` contains exactly `[B]`
- **AND** auto-poke is attempted against B's pane if B has a registered `tmux_pane_id` (may skip with `no_pane` or `guard_failed` per existing rules — those skips are orthogonal to online status)

#### Scenario: to_role with all-offline matches returns unknown_recipient

- **GIVEN** role `archivist` has two agents, both with `last_seen_at = now - 1 hour` (all offline)
- **WHEN** caller A calls `send_message({ to_role: 'archivist', body: "anything" })`
- **THEN** the response is `{ error: "unknown_recipient" }`
- **AND** no row is inserted in `messages` or `events`
- **AND** no poke / retry is attempted

#### Scenario: Broadcast with no online recipients besides sender returns unknown_recipient

- **GIVEN** team "solo" has agents A (sender) and B (`last_seen_at = now - 6 min`, offline)
- **WHEN** A calls `broadcast({ body: "hello" })`
- **THEN** the response is `{ error: "unknown_recipient" }`
- **AND** no row is inserted in `messages` or `events`

#### Scenario: list_agents still returns offline ghosts for diagnosis

- **GIVEN** team "default" contains 3 online agents + 25 offline ghost rows
- **WHEN** any caller invokes `list_agents()`
- **THEN** the response includes all 28 agents
- **AND** each has an `online: boolean` field reflecting the `last_seen_at < now - ONLINE_MS` check
- **AND** the 25 ghosts are flagged `online: false` but NOT removed from the response

#### Scenario: MCP tool descriptions document the fan-out online filter

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of `send_message` or `broadcast`
- **THEN** each description SHOULD state that role-based routing (for `send_message`) or team fan-out (for `broadcast`) skips recipients whose `last_seen_at` is more than 5 minutes old
- **AND** the `send_message` description SHOULD note that direct `to_agent_id` sends are NOT affected by this filter

### Requirement: send_message supports cross-team delivery when to_team is explicit

`send_message({to_agent_id, to_team, body, subject?, auto_poke?})` with `to_team` explicitly set to a value different from the caller's team SHALL deliver the message to `to_agent_id` in team `to_team`, provided that agent exists there.

The daemon MUST:

1. Resolve `to_team` = provided `to_team` value (or caller's team if omitted).
2. Look up the target agent row by `agent_id = to_agent_id` alone (global PK lookup).
3. Verify the target's `team` field equals the resolved `to_team`.  If not, return `{ error: 'unknown_recipient' }`.
4. Persist a `messages` row with `from_team = caller.team`, `to_team = resolved to_team`, `from_agent_id = caller.agent_id`, `to_agent_id = target`, `to_role = null`.
5. Persist a paired `events` row with matching `from_team` / `to_team`.
6. Proceed with auto-poke (subject to `auto_poke` parameter) using the same quiet-guard + retry-backoff mechanism as same-team delivery.

Cross-team delivery MUST NOT require any additional parameter (no `cross_team:true`, no permission token).  Explicit `to_team` is itself the signal of intent.

#### Scenario: Cross-team private message is delivered

- **GIVEN** caller `sess-A` in team `alpha`, target `sess-B` genuinely in team `beta`, B idle pane
- **WHEN** `sess-A` calls `send_message({to_agent_id:'sess-B', to_team:'beta', body:'cross-team ping'})`
- **THEN** response has `recipients: ['sess-B']`, `poked: true`, no `error`
- **AND** the `messages` row has `from_team='alpha', to_team='beta', from_agent_id='sess-A', to_agent_id='sess-B'`
- **AND** the paired `events` row has `from_team='alpha', to_team='beta', actor_agent_id='sess-A'`
- **AND** B's pane received the wake-up hint

#### Scenario: Cross-team `to_team` equal to caller's team is identical to omission

- **GIVEN** caller in team `alpha`, target `sess-B` in team `alpha`
- **WHEN** the caller invokes `send_message({to_agent_id:'sess-B', to_team:'alpha', body:'hi'})`
- **THEN** behavior is byte-identical to `send_message({to_agent_id:'sess-B', body:'hi'})`
- **AND** the resulting row has `from_team=to_team='alpha'`

#### Scenario: Cross-team target not found in specified team returns unknown_recipient

- **GIVEN** `sess-X` exists in team `gamma`, not in team `beta`
- **WHEN** caller in team `alpha` calls `send_message({to_agent_id:'sess-X', to_team:'beta', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no `messages` or `events` row is written

### Requirement: broadcast_to_role tool fans out to same-team role

The daemon SHALL expose an MCP tool `broadcast_to_role({to_role, body, subject?, auto_poke?})` that materializes one `messages` row per agent in the caller's team whose `role = to_role`, sharing a single `event_id`.  Sender is excluded from recipients.  All rows MUST have `from_team = to_team = caller.team` and `to_role = to_role` set; `to_agent_id` is set to the specific agent id (same pattern as the paired rows produced by the removed `send_message({to_role})` behavior, just relocated).

If no agent in the caller's team matches `to_role`, the daemon SHALL return `{ error: 'unknown_recipient' }` without writing any event.

`broadcast_to_role` MUST NOT accept a `to_team` parameter — it is strictly same-team.  The tool's MCP description MUST explicitly state this constraint.

Auto-poke, quiet-guard, retry-backoff, parallel fan-out, and hint-only poke body requirements apply identically to `broadcast_to_role` as they do to `broadcast` (see the Broadcast and Auto-poke requirements above).

The response shape MUST be:

```
{
  message_id: string,
  event_id: number,
  recipients: string[],           // agent_id list
  poked: boolean,
  poke_skip_reasons?: Array<{agent_id, reason}>,
  retry_scheduled: boolean,
  retry_delays_s?: number[]
}
```

#### Scenario: Two role-matching agents in team receive fan-out

- **GIVEN** agents `sess-F1` and `sess-F2` both have `role='frontend'` in team `default`, caller `sess-X` also in team `default`
- **WHEN** `sess-X` calls `broadcast_to_role({to_role:'frontend', body:'ship status'})`
- **THEN** `recipients` contains `['sess-F1', 'sess-F2']` (order-insensitive)
- **AND** two `messages` rows appear with identical `event_id`, `from_team=to_team='default'`, `to_role='frontend'`
- **AND** `recipients` does NOT include `sess-X` even if `sess-X` also has `role='frontend'` (sender always excluded)

#### Scenario: No matching role returns unknown_recipient

- **GIVEN** no agent in team `default` has `role='nonexistent'`
- **WHEN** caller calls `broadcast_to_role({to_role:'nonexistent', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }`
- **AND** no `messages` or `events` row is written

#### Scenario: Default auto-poke on broadcast_to_role fires for all idle-pane recipients in parallel

- **GIVEN** three role=`worker` agents in same team as caller, all with `tmux_pane_id` and idle panes, `POKE_QUIET_MS=100`
- **WHEN** caller calls `broadcast_to_role({to_role:'worker', body:'task ready'})` (auto_poke omitted)
- **THEN** response has `poked: true`, `poke_skip_reasons` absent or empty, `retry_scheduled: false`
- **AND** total call duration < 400ms (parallel, not 3 × 100ms)
- **AND** each recipient's pane received the wake-up hint

#### Scenario: broadcast_to_role does not accept to_team parameter

- **WHEN** a client calls `broadcast_to_role({to_role:'x', to_team:'beta', body:'hi'})`
- **THEN** the MCP tool's Zod schema MUST reject the call with a validation error (unknown field `to_team`)

#### Scenario: broadcast_to_role tool description states same-team scope

- **GIVEN** client fetches `tools/list`
- **WHEN** it reads the `description` of `broadcast_to_role`
- **THEN** the description SHOULD state the tool is strictly same-team
- **AND** SHOULD reference `send_message({to_team})` as the only cross-team path (and only for 1→1)
- **AND** SHOULD describe auto-poke default, quiet-guard, and retry-backoff consistent with `broadcast`

### Requirement: send_message is 1→1 private message only

`send_message({to_agent_id?, to_agent_name?, to_team?, subject?, body, auto_poke?})` MUST accept EITHER `to_agent_id` (UUID) OR `to_agent_name` (the target's `name` field in the `agents` table) as the recipient key, but NOT both and NOT neither. Requests containing a `to_role` parameter SHALL be rejected by the MCP tool schema layer (Zod validation) — the parameter is not defined on the tool at all.

The mutual-exclusion rule SHALL be enforced as follows:

- If neither `to_agent_id` nor `to_agent_name` is provided, the daemon SHALL return `{ error: 'missing_recipient' }`.
- If BOTH `to_agent_id` and `to_agent_name` are provided, the daemon SHALL return `{ error: 'ambiguous_recipient' }`.
- If exactly one is provided, the daemon SHALL proceed with routing (see the "send_message resolves to_agent_name" Requirement for the lookup semantics).

`send_message` MUST accept an optional `to_team` parameter. When `to_team` is omitted, the daemon SHALL default it to the caller's team. When `to_team` is provided and equals the caller's team, behavior is identical to omission. When `to_team` is provided and differs from the caller's team, the call constitutes a cross-team private message. The `to_team` default-and-equality rules apply identically whether the caller used `to_agent_id` or `to_agent_name`.

The `send_message` MCP tool description MUST state: 除非用户明确指定 `to_team`, 不要跨 team 沟通.  The description MUST also reference `broadcast_to_role` as the way to address a role, and `broadcast` as the way to reach the whole team. The description SHOULD mention `to_agent_name` as the preferred field when the caller knows the target by `(team, name)` rather than by UUID, and SHOULD note that exactly one of `to_agent_id` / `to_agent_name` must be provided.

#### Scenario: Both to_agent_id and to_agent_name given

- **WHEN** caller calls `send_message({to_agent_id:'uuid-B', to_agent_name:'bob', body:'hi'})`
- **THEN** response is `{ error: 'ambiguous_recipient' }`
- **AND** no new event row is created
- **AND** no new messages row is created

#### Scenario: Neither to_agent_id nor to_agent_name given

- **WHEN** caller calls `send_message({body:'hi'})`
- **THEN** response is `{ error: 'missing_recipient' }`
- **AND** no new event row is created

#### Scenario: Only to_agent_id given proceeds via UUID path

- **GIVEN** agent `sess-B` exists in the caller's team with `agent_id='uuid-B'`
- **WHEN** caller calls `send_message({to_agent_id:'uuid-B', body:'hi'})`
- **THEN** the message is persisted with `to_agent_id='uuid-B'`
- **AND** response `recipients` equals `['uuid-B']`

#### Scenario: Only to_agent_name given proceeds via name path

- **GIVEN** agent with `name='bob'` exists in the caller's team with `agent_id='uuid-B'`
- **WHEN** caller calls `send_message({to_agent_name:'bob', body:'hi'})`
- **THEN** the message is persisted with `to_agent_id='uuid-B'`
- **AND** response `recipients` equals `['uuid-B']`

#### Scenario: send_message tool description mentions to_agent_name

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of the tool named `send_message`
- **THEN** the description string SHALL reference `to_agent_name` as the preferred routing key when the caller knows the target by `(team, name)` rather than UUID
- **AND** SHALL indicate that exactly one of `to_agent_id` / `to_agent_name` must be provided
- **AND** SHALL retain the "除非用户明确指定 `to_team`, 不要跨 team 沟通" guardrail

### Requirement: send_message resolves to_agent_name via (team, name) lookup

When `send_message` is called with `to_agent_name` (and not `to_agent_id`), the daemon SHALL resolve the recipient UUID via `AgentsRepo.findByIdentity({ team: resolved_to_team, name: to_agent_name })`, where `resolved_to_team = to_team ?? caller.team`. The lookup is unambiguous because the `agents_identity_idx` UNIQUE INDEX on `(team, name)` guarantees at most one matching row.

If the lookup returns a row, the daemon SHALL proceed with the existing insert + auto-poke pipeline using the resolved `agent_id`, identical to the behaviour when the caller supplied that UUID directly as `to_agent_id`.

The `send_message` success envelope SHALL be unchanged: `{ message_id, event_id, recipients: [<resolved_uuid>], poked, poke_skip_reasons?, retry_scheduled, retry_delays_s? }`. The `recipients[]` field SHALL always contain the resolved UUID, never the name, regardless of which input path the caller used.

Cross-team sends via `to_agent_name` SHALL behave identically to cross-team sends via `to_agent_id`: the `from_team` / `to_team` values on the persisted `messages` and `events` rows reflect the resolved teams, and auto-poke fanout is not suppressed by the cross-team distinction on its own.

#### Scenario: Same-team send via to_agent_name persists and auto-pokes

- **GIVEN** agents `alice` (caller) and `bob` both in team 'default', both with `tmux_pane_id`
- **AND** bob's pane is idle, `POKE_QUIET_MS=100`
- **WHEN** alice calls `send_message({to_agent_name:'bob', body:'hi'})`
- **THEN** the message is persisted with `from_agent_id=<alice.uuid>`, `to_agent_id=<bob.uuid>`, `from_team='default'`, `to_team='default'`
- **AND** response `recipients` equals `[<bob.uuid>]`
- **AND** response `poked` is `true`
- **AND** bob's pane receives the wake-up hint

#### Scenario: Cross-team send via to_agent_name and explicit to_team

- **GIVEN** agent `alice` in team 'alpha' (caller), agent `bob` in team 'beta'
- **WHEN** alice calls `send_message({to_agent_name:'bob', to_team:'beta', body:'hi'})`
- **THEN** the message is persisted with `from_team='alpha'`, `to_team='beta'`, `to_agent_id=<bob.uuid in beta>`
- **AND** response `recipients` equals `[<bob.uuid in beta>]`

#### Scenario: Success envelope recipients is always the resolved UUID

- **GIVEN** agent `bob` in team 'default' with `agent_id='uuid-B'` and `name='bob'`
- **WHEN** caller A calls `send_message({to_agent_name:'bob', body:'hi'})`
- **AND** caller A calls `send_message({to_agent_id:'uuid-B', body:'hi'})`
- **THEN** both responses have `recipients === ['uuid-B']`

#### Scenario: Lookup is case-sensitive (byte-equal)

- **GIVEN** agent registered with `name='Bob'` in team 'default'
- **WHEN** caller calls `send_message({to_agent_name:'bob', body:'hi'})`
- **THEN** response is `{ error: 'unknown_recipient' }` (lowercase `bob` does not match stored `Bob`)

### Requirement: send_message carries reply expectation

`send_message` SHALL accept an optional `need_reply: boolean` parameter.  When omitted, `need_reply` MUST default to `true`.  When provided, the daemon MUST persist the exact boolean value on the created `messages` row.

The `send_message` MCP tool description MUST document that private messages default to expecting a reply, and that callers can set `need_reply:false` for FYI/no-response-needed messages.

`need_reply` is a mailbox contract visible to the recipient.  It MUST NOT change delivery, auto-poke, retry, or routing behavior.

#### Scenario: send_message defaults to needing reply

- **GIVEN** agents `sess-A` and `sess-B` are in the same team
- **WHEN** `sess-A` calls `send_message({to_agent_id:'sess-B', body:'question', auto_poke:false})`
- **THEN** the created `messages` row has `need_reply=1`

#### Scenario: send_message can opt out of reply expectation

- **GIVEN** agents `sess-A` and `sess-B` are in the same team
- **WHEN** `sess-A` calls `send_message({to_agent_id:'sess-B', body:'FYI', need_reply:false, auto_poke:false})`
- **THEN** the created `messages` row has `need_reply=0`

#### Scenario: send_message description documents need_reply

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of the tool named `send_message`
- **THEN** the description string SHALL mention `need_reply`
- **AND** SHALL state that `need_reply:false` means no reply is expected

### Requirement: Fan-out messages are no-reply by default

`broadcast` and `broadcast_to_role` SHALL persist `need_reply=false` for every created `messages` row.  These tools MUST NOT accept a `need_reply` input parameter in this change.

#### Scenario: broadcast rows are marked no-reply

- **GIVEN** team `default` has agents `sess-A`, `sess-B`, and `sess-C`
- **WHEN** `sess-A` calls `broadcast({body:'all-hands', auto_poke:false})`
- **THEN** every created `messages` row has `need_reply=0`

#### Scenario: broadcast_to_role rows are marked no-reply

- **GIVEN** team `default` has two agents with role `worker`
- **WHEN** caller calls `broadcast_to_role({to_role:'worker', body:'status', auto_poke:false})`
- **THEN** every created `messages` row has `need_reply=0`

