## ADDED Requirements

### Requirement: Internal wake delivery primitive remains daemon-only
The daemon SHALL keep an internal wake delivery primitive that can deliver the fixed auto-poke hint through the configured transport stack, but it MUST NOT expose that primitive as a public MCP tool for ordinary agents.  Internal callers include `send_message`, `broadcast`, `broadcast_to_role`, and retry ticks.

#### Scenario: Auto-poke can still call the internal primitive
- **GIVEN** agent A sends a message to agent B and B has an idle delivery transport
- **WHEN** the auto-poke path runs inside the daemon
- **THEN** the daemon delivers the fixed wake hint to B
- **AND** no public `poke` tool is required for that delivery

#### Scenario: Public tools do not include poke
- **GIVEN** a registered agent MCP session
- **WHEN** the client calls `tools/list`
- **THEN** the response MUST NOT contain a tool named `poke`

## MODIFIED Requirements

### Requirement: poke tool registration and input schema

The daemon SHALL NOT register a public MCP tool named `poke` for ordinary agent sessions.  Public MCP clients MUST NOT be able to call `poke({ target_agent_id, prompt })` through the tool registry, and `poke` MUST NOT appear in the MCP server's `list_tools` response.

The daemon MAY keep internal functions and transport-specific envelopes for wake delivery, but those functions are not part of the public MCP tool schema.

#### Scenario: poke does not appear in list_tools

- **GIVEN** a running daemon with an initialized MCP session
- **WHEN** the client calls `tools/list`
- **THEN** the response contains no tool entry with `name === 'poke'`

#### Scenario: Direct poke call is unavailable

- **GIVEN** a running daemon with an initialized MCP session
- **WHEN** the client attempts to call a tool named `poke`
- **THEN** the server rejects the call because no such public tool is registered
- **AND** no wake delivery transport is invoked

### Requirement: Internal auto-poke bypasses the cross-team check

When the daemon's internal auto-poke implementation (`createAutoPokeImpl`, invoked by `send_message` / `broadcast` / `broadcast_to_role` fan-out paths) calls the internal wake delivery primitive to inject a wake-up hint, the caller-team-vs-target-team equality check MUST be bypassed, even when the caller and target belong to different teams.

The prompt injected via this path is fixed to the format `新邮件 from {sender_identifier}, 请调 get_inbox 查看` (built by `buildAutoPokeHint`).  The bypass is permitted ONLY because the prompt format is constant and contains no message-body substring; any future internal path that wishes to bypass the cross-team check MUST also restrict its prompt to a constrained, non-leaky format.

No public MCP tool input schema may expose any parameter that controls this bypass; the bypass is strictly internal to the daemon's process.

#### Scenario: Cross-team send_message triggers a successful auto-poke

- **GIVEN** agent `sess-A` is registered in team `alpha` with `tmux_pane_id='%pA'`
- **AND** agent `sess-B` is registered in team `beta` with `tmux_pane_id='%pB'` and its pane is idle
- **AND** `POKE_QUIET_MS=50` for test speed
- **WHEN** `sess-A` invokes `send_message({to_agent_id:'sess-B', to_team:'beta', body:'hi'})`
- **THEN** the response has `poked: true`
- **AND** `poke_skip_reasons` does NOT contain `{agent_id:'sess-B', reason:'guard_failed'}`
- **AND** `%pB` has received a `paste-buffer` + `send-keys Enter` sequence carrying the hint `新邮件 from <A's display name or agent_id[:8]>, 请调 get_inbox 查看`

#### Scenario: Direct MCP poke is not the bypass path

- **GIVEN** agent `sess-A` in team `alpha`, agent `sess-B` in team `beta`, both with valid panes
- **WHEN** `sess-A` attempts to invoke a public MCP tool named `poke`
- **THEN** the call is rejected because no such public tool is registered
- **AND** the internal cross-team auto-poke bypass has no bearing on that direct call

## REMOVED Requirements

### Requirement: Cross-team poke via the MCP tool is rejected

**Reason**: The public MCP `poke` tool is removed entirely, so there is no direct same-team or cross-team poke surface to validate.

**Migration**: Agents MUST use `send_message`, `broadcast`, or `broadcast_to_role`; those tools persist mailbox rows, auto-poke by default, and expose delivery status.

### Requirement: Caller must be a registered agent

**Reason**: The public MCP `poke` tool is removed, so public caller validation for that tool is obsolete.

**Migration**: Registration requirements remain enforced by the message and status-query tools.

### Requirement: Unknown target_agent_id returns unknown_target

**Reason**: The public MCP `poke` tool is removed, so public target validation for that tool is obsolete.

**Migration**: Recipient validation remains enforced by `send_message`, `broadcast`, and `broadcast_to_role`.

### Requirement: Self-poke is rejected

**Reason**: The public MCP `poke` tool is removed, so direct self-poke is no longer possible.

**Migration**: Auto-poke fan-out still records `self` as a skip reason defensively when internal callers encounter the sender as a recipient.
