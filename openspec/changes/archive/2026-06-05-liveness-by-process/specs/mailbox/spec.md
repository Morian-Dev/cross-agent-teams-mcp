## REMOVED Requirements

### Requirement: Fan-out routing skips offline recipients

**Reason**: The 5-minute `last_seen_at` idle window is the wrong reachability model for agents. An idle-but-running standby agent (its `runtime_ui_pid` process still alive) is fully able to receive mail, yet this requirement silently dropped it from every `broadcast` / `to_role` fan-out — giving it no mailbox row, no event, no poke — which forced callers to fall back to manual `list_agents` + per-agent `send_message`. The actual wake path (`auto-poke-fanout`) never used this window; it only gated recipient selection and the `online` flag.

**Migration**: Fan-out (`broadcast`, `send_message({to_role})`) now delivers a mailbox row to every team member exactly like a direct send — see the new "Fan-out routing delivers to all team members" Requirement. The `online` flag is redefined as process liveness — see agent-registry "Agent liveness is process-based". No data migration is needed; behavior changes on deploy. Callers that relied on `broadcast` recipients meaning "currently online" will now receive all members; offline members accumulate inbox rows until the existing 30-day retention cleanup, identical to how direct sends already behave.

## ADDED Requirements

### Requirement: Fan-out routing delivers to all team members

`broadcast` and `send_message({to_role})` SHALL enumerate their full member set and deliver a mailbox row to every member, with NO filtering by `last_seen_at` recency or liveness — identical to direct-send delivery semantics. Specifically:

1. `broadcast({ body })` — every agent in the caller's team across all devices, except the caller itself.
2. `send_message({ to_role })` — every agent whose `role` matches in the caller's team.

An idle or offline member (regardless of `last_seen_at`) MUST still receive its mailbox row and event. The auto-poke wake attempt remains best-effort and is gated only by the existing pane / transport checks (`no_pane`, `guard_failed`, `tmux_unavailable`) and retry rules — those skips are orthogonal to liveness and unchanged.

The daemon SHALL return `{ error: "unknown_recipient" }` from a fan-out ONLY when the enumerated member set is genuinely empty: for `broadcast`, when the caller is the sole member of its team; for `to_role`, when no agent in the team holds that role. An empty set MUST NOT arise merely because members are idle.

#### Scenario: Broadcast delivers to every team member including idle ones

- **GIVEN** team "default" has agents A (sender, `last_seen_at = now`), B (`last_seen_at = now - 1 min`), C (`last_seen_at = now - 10 min`), D (`last_seen_at = now - 3 days`)
- **WHEN** A calls `broadcast({ body: "status update" })`
- **THEN** the response `recipients` array contains exactly `[B, C, D]` (order-insensitive) — none is excluded for idleness
- **AND** B, C, and D each have a new row in `messages` for this broadcast
- **AND** all resulting messages rows have `from_team = to_team = 'default'`

#### Scenario: to_role delivers to every matching agent including idle ones

- **GIVEN** team "default" has agents F1 (`role=frontend`, `last_seen_at = now - 1 min`), F2 (`role=frontend`, `last_seen_at = now - 2 hours`), F3 (`role=frontend`, `last_seen_at = now`)
- **WHEN** A calls `send_message({ to_role: 'frontend', body: "hi frontends" })`
- **THEN** `recipients` contains exactly `[F1, F2, F3]`
- **AND** F2 has a mailbox entry for this event despite being idle
- **AND** the `events` row has `payload.recipients = [F1, F2, F3]`

#### Scenario: Broadcast with the sender as sole team member returns unknown_recipient

- **GIVEN** team "solo" contains only agent A (the sender)
- **WHEN** A calls `broadcast({ body: "hello" })`
- **THEN** the response is `{ error: "unknown_recipient" }`
- **AND** no row is inserted in `messages` or `events`

#### Scenario: to_role with no agent under the role returns unknown_recipient

- **GIVEN** no agent in team "default" holds role `archivist`
- **WHEN** caller A calls `send_message({ to_role: 'archivist', body: "anything" })`
- **THEN** the response is `{ error: "unknown_recipient" }`
- **AND** no row is inserted in `messages` or `events`

#### Scenario: Idle members are still addressed (no idle-based emptiness)

- **GIVEN** team "default" has agents A (sender) and B (`last_seen_at = now - 6 min`)
- **WHEN** A calls `broadcast({ body: "hello" })`
- **THEN** the response `recipients` array contains exactly `[B]`
- **AND** B has a new mailbox row for this broadcast (it is NOT treated as an empty fan-out)

#### Scenario: MCP tool descriptions reflect all-member fan-out

- **GIVEN** a client fetches the MCP tool list via `tools/list`
- **WHEN** it reads the `description` of `broadcast` or `send_message`
- **THEN** the descriptions MUST NOT claim that fan-out skips recipients idle for more than 5 minutes
- **AND** the `broadcast` description states that it delivers to every team member except the sender
