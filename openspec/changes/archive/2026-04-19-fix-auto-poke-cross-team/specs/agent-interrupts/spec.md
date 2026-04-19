## MODIFIED Requirements

### Requirement: Cross-team poke via the MCP tool is rejected

When a caller invokes the `poke` MCP tool directly AND the target's `team` does not equal the caller's `team`, the daemon SHALL return `{ error: 'cross_team_denied' }` without executing any tmux command.

This constraint applies only to **direct MCP tool calls**. Internal auto-poke dispatched by `send_message`, `broadcast`, or `broadcast_to_role` bypasses this check — see Requirement "Internal auto-poke bypasses the cross-team check".

#### Scenario: Cross-team target via MCP tool

- **GIVEN** caller `sess-A` is in team `alpha` and target `sess-B` is in team `beta`
- **WHEN** `sess-A` invokes the `poke` MCP tool with `{ target_agent_id: 'sess-B', prompt: 'p' }`
- **THEN** the response is `{ error: 'cross_team_denied' }`
- **AND** no tmux command is executed

## ADDED Requirements

### Requirement: Internal auto-poke bypasses the cross-team check

When the daemon's internal auto-poke implementation (`createAutoPokeImpl`, invoked by `send_message` / `broadcast` / `broadcast_to_role` fan-out paths) calls `poke()` to inject a wake-up hint, the caller-team-vs-target-team equality check MUST be bypassed, even when the caller and target belong to different teams.

The prompt injected via this path is fixed to the format `新邮件 from {sender_identifier}, 请调 get_inbox 查看` (built by `buildAutoPokeHint`). The bypass is permitted ONLY because the prompt format is constant and contains no message-body substring; any future path that wishes to bypass the cross-team check MUST also restrict its prompt to a constrained, non-leaky format.

The MCP `poke` tool input schema MUST NOT expose any parameter that controls this bypass; the bypass is strictly internal to the daemon's process.

#### Scenario: Cross-team send_message triggers a successful auto-poke

- **GIVEN** agent `sess-A` is registered in team `alpha` with `tmux_pane_id='%pA'`
- **AND** agent `sess-B` is registered in team `beta` with `tmux_pane_id='%pB'` and its pane is idle
- **AND** `POKE_QUIET_MS=50` for test speed
- **WHEN** `sess-A` invokes `send_message({to_agent_id:'sess-B', to_team:'beta', body:'hi'})`
- **THEN** the response has `poked: true`
- **AND** `poke_skip_reasons` does NOT contain `{agent_id:'sess-B', reason:'guard_failed'}`
- **AND** `%pB` has received a `paste-buffer` + `send-keys Enter` sequence carrying the hint `新邮件 from <A's display name or agent_id[:8]>, 请调 get_inbox 查看`

#### Scenario: Direct MCP poke call with the same cross-team pair still denied

- **GIVEN** agent `sess-A` in team `alpha`, agent `sess-B` in team `beta`, both with valid panes
- **WHEN** `sess-A` invokes the `poke` MCP tool with `{ target_agent_id: 'sess-B', prompt: 'p' }`
- **THEN** the response is `{ error: 'cross_team_denied' }`
- **AND** no tmux command is executed
- **AND** the fact that internal auto-poke is permitted for the same pair has no bearing on this direct call
