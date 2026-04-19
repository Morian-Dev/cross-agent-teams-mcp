## REMOVED Requirements

### Requirement: Broadcast auto-poke is opt-in

**Reason**: 当前部署的所有 team 成员数都很小 (典型 2-4 agent). 默认 `auto_poke=false` 的 broadcast 等同于"消息黑洞" — LLM 收件方不会自发 chain `poke`, 收件人若不主动 `get_inbox` 永远不知道. E2E 测试 (2026-04-19) 暴露此问题. 翻为默认 ON 与 send_message 对齐, 把"正确行为"做成默认.

**Migration**: 调用方若希望抑制广播 poke (例如非紧急 status update), 显式传 `auto_poke: false`. 现有 wire format 不变, response 字段 (`poked`, `poke_skip_reasons`, `retry_scheduled`, `retry_delays_s`) 全部已存在, 仅默认值语义翻转.

## MODIFIED Requirements

### Requirement: broadcast excludes sender

`broadcast({body, subject?})` SHALL fan-out to every agent in the caller's team except the caller itself.

#### Scenario: Sender not in recipients

- **GIVEN** team 'default' has agents `sess-A`, `sess-B`, `sess-C`
- **WHEN** `sess-A` calls `broadcast({body:'all-hands'})`
- **THEN** `recipients` contains exactly `['sess-B','sess-C']`

### Requirement: Fire-and-forget delivery contract for send_message and broadcast

`send_message` MUST follow a fire-and-forget delivery contract regarding event-outbox semantics:

1. The tool MUST persist to the mailbox (and event outbox) and return synchronously (modulo the optional auto-poke quiet-guard window).
2. The tool's MCP description MUST advise callers that `auto_poke` is the default and may be opted out via `auto_poke:false`.

This Requirement applies to `send_message` only. `broadcast` is governed by the separate `Broadcast auto-poke default with parallel fan-out` Requirement, which mandates auto-poke as default rather than fire-and-forget. The header retains "and broadcast" for historical continuity with the Requirement introduced by `add-auto-poke-on-send`; the body of this Requirement SHALL be read as authoritative over the header text — `broadcast` is explicitly carved out.

#### Scenario: send_message with auto_poke:false is pure fire-and-forget

- **GIVEN** recipient `sess-B` has a valid `tmux_pane_id` registered
- **WHEN** caller `sess-A` calls `send_message({to_agent_id:'sess-B', body:'any', auto_poke:false})`
- **THEN** no `poke` entry, no tmux-injection event, no side effect beyond mailbox persistence occurs

## ADDED Requirements

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
