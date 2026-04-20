## MODIFIED Requirements

### Requirement: poke dispatches via transport abstraction

`poke({target_agent_id, prompt})` SHALL perform transport selection and fallback as follows:

1. Look up the target row: `SELECT channel_session_id, opencode_base_url, opencode_session_id, tmux_pane_id, team FROM agents WHERE agent_id = ?`.
2. If the target does not exist, return `{error: 'unknown_target'}`.
3. Self-poke and cross-team checks remain unchanged; `allowCrossTeam` internal flag still governs auto-poke bypass.
4. If `channel_session_id` is non-null AND the daemon's `ChannelWakeFanout` has a live sink attached for that id, call the internal `sendChannelWake(channel_session_id, {content, meta})`.  On success, return `{ok: true, transport_used: 'claude-channel', channel_session_id}`.
5. Otherwise, if both `opencode_base_url` and `opencode_session_id` are non-null, call the internal opencode transport helper.  On success, return `{ok: true, transport_used: 'opencode-server', base_url, session_id}`.
6. If steps 4-5 did not return success, AND `tmux_pane_id` is non-null, perform the existing tmux-based poke flow.  On success, return `{ok: true, pane_id, pane_tail_before, pane_tail_after, transport_used: 'tmux-poke'}`.  On tmux error, return the classified error with `transport_used: 'tmux-poke'`.
7. If none of the three transports is configured, return `{error: 'no_transport_available', detail: {channel_subscribed: <bool>, opencode_bound: <bool>, tmux_pane_set: <bool>}}`.

The tool MUST NOT fan a wake-up via multiple transports for a single poke call.  Successful Claude channel delivery short-circuits opencode and tmux, and successful opencode delivery short-circuits tmux.

#### Scenario: poke prefers claude-channel over opencode and tmux

- **GIVEN** target agent `bob` has `channel_session_id='csid-bob'`, `opencode_base_url='http://127.0.0.1:4096'`, `opencode_session_id='sess-bob'`, and `tmux_pane_id='%99'`
- **AND** the channel proxy subscribing to `csid-bob` is online
- **WHEN** `alice` calls `poke({target_agent_id:'bob', prompt:'p'})`
- **THEN** the response is `{ok: true, transport_used: 'claude-channel', channel_session_id: 'csid-bob'}`
- **AND** the daemon does NOT call the opencode transport helper
- **AND** no `tmux` command is executed

#### Scenario: poke uses opencode when channel sink absent and opencode bound

- **GIVEN** target `bob` has `channel_session_id='csid-bob'`, `opencode_base_url='http://127.0.0.1:4096'`, `opencode_session_id='sess-bob'`, and `tmux_pane_id='%99'`
- **AND** no sink is attached for `csid-bob`
- **AND** the opencode server is reachable and accepts the prompt for `sess-bob`
- **WHEN** `alice` calls `poke({target_agent_id:'bob', prompt:'p'})`
- **THEN** the response is `{ok: true, transport_used: 'opencode-server', base_url: 'http://127.0.0.1:4096', session_id: 'sess-bob'}`
- **AND** no `tmux` command is executed

#### Scenario: poke falls back to tmux when opencode not bound

- **GIVEN** target `bob` has `channel_session_id=NULL`, `opencode_base_url=NULL`, `opencode_session_id=NULL`, and `tmux_pane_id='%99'`
- **WHEN** `alice` calls `poke({target_agent_id:'bob', prompt:'p'})`
- **THEN** the daemon executes the tmux paste-then-enter flow on pane `%99`
- **AND** the response is `{ok: true, transport_used: 'tmux-poke', pane_id: '%99', pane_tail_before: ..., pane_tail_after: ...}`

#### Scenario: poke returns no_transport_available when no route is configured

- **GIVEN** target `bob` has `channel_session_id=NULL`, `opencode_base_url=NULL`, `opencode_session_id=NULL`, and `tmux_pane_id=NULL`
- **WHEN** `alice` calls `poke({target_agent_id:'bob', prompt:'p'})`
- **THEN** the response is `{error: 'no_transport_available', detail: {channel_subscribed: false, opencode_bound: false, tmux_pane_set: false}}`
- **AND** no tmux command is executed

#### Scenario: poke response envelope carries expanded transport_used values

- **GIVEN** any poke call that succeeds via one transport
- **WHEN** the response envelope is inspected
- **THEN** the envelope contains a `transport_used` field whose value is one of `'claude-channel'`, `'opencode-server'`, or `'tmux-poke'`
