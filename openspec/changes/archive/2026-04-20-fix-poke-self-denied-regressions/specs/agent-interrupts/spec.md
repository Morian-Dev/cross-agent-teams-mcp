# agent-interrupts Delta — fix-poke-self-denied-regressions

## MODIFIED Requirements

### Requirement: Self-poke is rejected

If `target_agent_id` equals the caller's own `agent_id`, the daemon MUST return `{ error: 'self_poke_denied' }`. The judgment is keyed strictly on the canonical `agent_id` (the `agents` table primary key); no other attribute (team, role, name, tmux_pane_id, channel_session_id, MCP session id, or process pid) MAY trigger this error on its own.

#### Scenario: Caller pokes self

- **GIVEN** caller `sess-A` is registered
- **WHEN** `sess-A` calls `poke({ target_agent_id: 'sess-A', prompt: 'p' })`
- **THEN** the response is `{ error: 'self_poke_denied' }`
- **AND** no tmux command is executed

#### Scenario: Distinct agents are never treated as self-poke

- **GIVEN** caller agent `A` (`agent_id='id-A'`, `team='default'`, `name='alice'`, `tmux_pane_id='%42'`)
- **AND** target agent `B` (`agent_id='id-B'`, `team='default'`, `name='bob'`, `tmux_pane_id='%42'`)
- **AND** `id-A !== id-B`
- **WHEN** `A` calls `poke({ target_agent_id: 'id-B', prompt: 'p' })`
- **THEN** the response is NOT `{ error: 'self_poke_denied' }`
- **AND** the tmux delivery pipeline is allowed to proceed (subject to other guards such as `tmux_pane_not_set`, `tmux_unavailable`, `pane_dead`)
- **AND** the equality of any non-`agent_id` attribute (here both share `tmux_pane_id='%42'` and `team='default'`) MUST NOT short-circuit to `self_poke_denied`
