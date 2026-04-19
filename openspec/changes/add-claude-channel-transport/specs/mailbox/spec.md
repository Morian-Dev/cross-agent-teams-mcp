## MODIFIED Requirements

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
