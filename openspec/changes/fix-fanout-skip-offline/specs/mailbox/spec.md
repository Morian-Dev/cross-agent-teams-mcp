## ADDED Requirements

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
