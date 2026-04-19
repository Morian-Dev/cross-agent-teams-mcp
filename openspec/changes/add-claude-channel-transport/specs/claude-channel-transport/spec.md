## ADDED Requirements

### Requirement: Channel proxy declares claude/channel experimental capability

The channel proxy SHALL declare `capabilities.experimental['claude/channel']: {}` in its MCP server `initialize` response.  This capability is the signal Claude Code uses to register the `notifications/claude/channel` listener and route subsequent notifications into context as a `<channel>` tag.

#### Scenario: proxy declares claude/channel experimental capability

- **GIVEN** the proxy is spawned with `--daemon-url http://localhost:8787`
- **WHEN** an MCP client (simulating Claude Code) sends `initialize` over the proxy's stdio
- **THEN** the `initialize` response includes `capabilities.experimental` containing the key `claude/channel` with value `{}`

### Requirement: ChannelWakeFanout tracks sinks keyed by channel_session_id

The daemon SHALL maintain an in-memory `ChannelWakeFanout` map from `channel_session_id: string` to a single sink callback that emits JSON-RPC notifications on the subscribing MCP session's Streamable HTTP transport.  Only the most recent subscription per `channel_session_id` is retained; re-subscription replaces the previous sink.

#### Scenario: attach and send fan out only to the matched sink

- **GIVEN** no sinks attached
- **WHEN** `attach('csid-1', sink1)` and `attach('csid-2', sink2)` are called
- **THEN** `send('csid-1', payload)` invokes `sink1` exactly once and does NOT invoke `sink2`

#### Scenario: detach removes sink

- **GIVEN** `attach('csid-1', sink1)` has been called
- **WHEN** `detach('csid-1')` is called, then `send('csid-1', payload)` is called
- **THEN** `sink1` is NOT invoked

#### Scenario: re-subscription replaces prior sink

- **GIVEN** `attach('csid-1', sinkA)` has been called
- **WHEN** `attach('csid-1', sinkB)` is called, then `send('csid-1', payload)` is called
- **THEN** `sinkB` is invoked exactly once and `sinkA` is NOT invoked

#### Scenario: detachBySession removes all sinks owned by an MCP session

- **GIVEN** MCP session `sess-P` attached sinks under `csid-1` and `csid-2` (both created from `sess-P`'s transport)
- **WHEN** `detachBySession('sess-P')` is called
- **THEN** `ChannelWakeFanout` contains no entry for `csid-1` nor `csid-2`

### Requirement: subscribe_channel_wake MCP tool attaches sink with role gating

The daemon SHALL register an MCP tool `subscribe_channel_wake({channel_session_id: string})`.  When invoked:

1. The caller MUST be a registered agent (session is bound to an `agent_id`); otherwise return `{error: 'unknown_agent'}`.
2. The caller's `role` MUST be `'__channel_proxy__'`; otherwise return `{error: 'forbidden_role'}`.
3. Otherwise attach the calling session's notification sink to `ChannelWakeFanout` under the provided `channel_session_id` and return `{ok: true}`.

When the MCP session transport closes, the daemon MUST call `ChannelWakeFanout.detachBySession(sessionId)` to clean up.

#### Scenario: subscribe_channel_wake succeeds for __channel_proxy__ caller

- **GIVEN** a caller registered with `role='__channel_proxy__'`
- **WHEN** the caller invokes `subscribe_channel_wake({channel_session_id: 'csid-abc'})`
- **THEN** the tool returns `{ok: true}`
- **AND** `ChannelWakeFanout` has a sink attached under key `'csid-abc'`

#### Scenario: subscribe_channel_wake rejects non-proxy caller

- **GIVEN** a caller registered with `role='backend'`
- **WHEN** the caller invokes `subscribe_channel_wake({channel_session_id: 'csid-abc'})`
- **THEN** the response is `{error: 'forbidden_role'}`
- **AND** no sink is attached

#### Scenario: session close detaches subscriptions

- **GIVEN** proxy session attached a sink under `'csid-abc'`
- **WHEN** the proxy's MCP transport closes
- **THEN** the sink is removed from `ChannelWakeFanout`

### Requirement: bind_channel MCP tool writes channel_session_id to caller's agents row

The daemon SHALL register an MCP tool `bind_channel({channel_session_id: string})` for self-binding a Claude Code host to its proxy's channel session.  The caller identity is resolved from the session (the MCP session is already bound to an `agent_id` via `register_agent`); `bind_channel` does NOT accept `team` or `name` arguments.  When invoked:

1. The caller MUST be a registered agent (session bound to an `agent_id`); otherwise return `{error: 'unknown_agent'}`.
2. The caller's `role` MUST NOT be `'__channel_proxy__'` (proxies never bind themselves as channel owners); non-proxy roles are all accepted.
3. `channel_session_id` MUST be a trimmed non-empty string; otherwise return `{error: 'invalid_channel_session_id'}`.
4. The `channel_session_id` MUST correspond to a currently-attached sink in `ChannelWakeFanout` (i.e. a live proxy session already called `subscribe_channel_wake` with this csid); otherwise return `{error: 'unknown_channel_session'}`.  This guards against Claude typing a random string and catches races where Claude tries to bind after the proxy session already closed.
5. Otherwise UPDATE `agents.channel_session_id = <csid>` WHERE `agent_id = <caller's agent_id>` and return `{ok: true}`.

#### Scenario: bind_channel updates caller's agents row when csid has live sink

- **GIVEN** agent `alice` exists with `channel_session_id=NULL` and is the MCP session caller
- **AND** a proxy session has attached a `ChannelWakeFanout` sink under `csid-abc`
- **WHEN** alice invokes `bind_channel({channel_session_id: 'csid-abc'})`
- **THEN** the response is `{ok: true}`
- **AND** the agents row for alice has `channel_session_id='csid-abc'`

#### Scenario: bind_channel rejects unknown channel_session_id

- **GIVEN** agent `alice` is the MCP session caller
- **AND** no `ChannelWakeFanout` sink is attached under `csid-ghost`
- **WHEN** alice invokes `bind_channel({channel_session_id: 'csid-ghost'})`
- **THEN** the response is `{error: 'unknown_channel_session'}`
- **AND** the agents row for alice is unchanged

#### Scenario: bind_channel rejects proxy caller

- **GIVEN** a caller registered with `role='__channel_proxy__'`
- **AND** a `ChannelWakeFanout` sink is attached under `csid-abc`
- **WHEN** the proxy caller invokes `bind_channel({channel_session_id: 'csid-abc'})`
- **THEN** the response is `{error: 'forbidden_role'}`

### Requirement: daemon emits notifications/channel_wake with sanitized meta

The daemon SHALL expose an internal `sendChannelWake(channel_session_id, {content: string, meta: Record<string, string>})` function.  If a sink is attached for the given `channel_session_id`, it emits a JSON-RPC notification with method `notifications/channel_wake` and params `{content, meta}`.  Meta keys NOT matching `/^[A-Za-z0-9_]+$/` MUST be silently dropped before send.  Meta values MUST be strings.  If no sink is attached, `sendChannelWake` returns `{ok: false, reason: 'no_subscriber'}` without emitting.

#### Scenario: sendChannelWake emits notifications/channel_wake payload

- **GIVEN** a sink attached under `'csid-abc'` that records emitted JSON-RPC payloads
- **WHEN** `sendChannelWake('csid-abc', {content: 'you have 3 unread', meta: {message_count: '3', latest_sender: 'alice'}})` is called
- **THEN** the recorded payload equals `{jsonrpc: '2.0', method: 'notifications/channel_wake', params: {content: 'you have 3 unread', meta: {message_count: '3', latest_sender: 'alice'}}}`

#### Scenario: meta keys containing hyphens are dropped before send

- **GIVEN** a sink attached under `'csid-abc'`
- **WHEN** `sendChannelWake('csid-abc', {content: 'hi', meta: {message_count: '3', 'bad-key': 'oops'}})` is called
- **THEN** the recorded payload's `params.meta` equals `{message_count: '3'}` (`'bad-key'` dropped)

#### Scenario: sendChannelWake with no subscriber returns no_subscriber

- **GIVEN** no sink attached under `'csid-none'`
- **WHEN** `sendChannelWake('csid-none', {content: 'x', meta: {}})` is called
- **THEN** the return value equals `{ok: false, reason: 'no_subscriber'}`
- **AND** no JSON-RPC payload is emitted on any transport

### Requirement: Channel proxy startup sequence

On startup, the channel proxy SHALL, in order:

1. Parse CLI args: `--daemon-url <url>` (or env `TS_AGENT_TEAMS_DAEMON_URL`).  The proxy is identity-agnostic — it MUST NOT accept `--agent-team` or `--agent-name`.  If daemon-url is missing, exit with a non-zero status and a diagnostic on stderr.
2. Generate a fresh UUID v4 as `channel_session_id` for this process lifetime.  No persistence — each proxy startup gets a new csid.  (Rationale: the proxy is shared-by-directory in `.mcp.json`, so persisting by identity would collide across multi-instance Claude Code runs; a fresh csid per startup sidesteps the issue entirely.)
3. Open an MCP Streamable HTTP client to `<daemon-url>`.
4. Call `register_agent({role: '__channel_proxy__', name: 'channel-proxy-<pid>', team: 'default', model: 'proxy'})` to establish its own MCP session identity.
5. Call `subscribe_channel_wake({channel_session_id: <csid>})` to attach its notification sink.
6. Emit a `notifications/claude/channel` JSON-RPC notification on its host stdio telling Claude: its `channel_session_id` is `<csid>` and it should call `bind_channel({channel_session_id: '<csid>'})` to complete binding.  This hands off self-binding to Claude.
7. Enter an idle loop receiving `notifications/channel_wake` from the daemon and relaying them to the host.

#### Scenario: proxy generates fresh csid on every startup

- **GIVEN** a proxy binary
- **WHEN** the proxy starts with `--daemon-url http://localhost:8787`
- **THEN** the proxy generates a fresh UUID v4 as its `channel_session_id`
- **AND** does NOT read or write any persistence file

#### Scenario: proxy emits startup channel notification with csid and bind instruction

- **GIVEN** the proxy has completed `register_agent` and `subscribe_channel_wake` successfully with `channel_session_id='csid-xyz'`
- **WHEN** the proxy is about to enter its idle loop
- **THEN** the proxy emits a `notifications/claude/channel` JSON-RPC notification to its host
- **AND** the notification `params.content` contains the literal string `csid-xyz`
- **AND** the notification `params.content` mentions `bind_channel`

### Requirement: Channel proxy relays channel_wake as claude/channel notification

When the proxy receives a `notifications/channel_wake` notification from the daemon with params `{content, meta}`, it SHALL emit a `notifications/claude/channel` notification to its host stdio with params `{content, meta}` unchanged (no rewriting of keys or values).

#### Scenario: proxy relays channel_wake as claude/channel notification

- **GIVEN** the proxy is running with its host stdio attached to a fake MCP client
- **WHEN** the fake daemon sends `notifications/channel_wake` with `params: {content: 'hi', meta: {message_count: '3'}}`
- **THEN** the fake client receives a JSON-RPC notification with method `notifications/claude/channel` and `params: {content: 'hi', meta: {message_count: '3'}}`

#### Scenario: proxy drops relay without crashing when host stdio is closed

- **GIVEN** the proxy's host stdio has been closed (e.g. Claude Code exited)
- **WHEN** a `notifications/channel_wake` arrives from the daemon
- **THEN** the proxy logs the drop to stderr but does NOT crash

### Requirement: Channel proxy reconnects on daemon disconnect

When the proxy's MCP connection to the daemon closes unexpectedly, the proxy SHALL attempt reconnection with exponential backoff (initial 500ms, capped 30s, jittered).  On each successful reconnect the proxy MUST re-execute the registration sequence (`register_agent` → `subscribe_channel_wake` → emit host-startup notification) in order.  During disconnect periods the proxy MUST NOT emit any `notifications/claude/channel` relay to its host.

#### Scenario: proxy reconnects and re-subscribes after daemon disconnect

- **GIVEN** proxy is connected to a fake daemon and subscribed
- **WHEN** the fake daemon closes the MCP transport
- **THEN** the proxy retries the HTTP MCP connect within 2 seconds (first retry in the schedule)
- **AND** upon reconnect, the proxy re-calls `register_agent`, `subscribe_channel_wake` in order

### Requirement: End-to-end poke via channel transport

When an authenticated agent calls `poke({target_agent_id, prompt})` and the target agent has a non-null `channel_session_id` and a live channel proxy sink attached, the daemon MUST route the wake-up via `sendChannelWake` and MUST NOT perform any tmux operation.

#### Scenario: end-to-end poke via channel transport

- **GIVEN** the daemon is running on a random port
- **AND** a channel proxy subprocess is running and subscribed under `channel_session_id='csid-bob'`
- **AND** agent `bob` has `channel_session_id='csid-bob'` (bound via `bind_channel` by the host Claude after receiving the startup notification; tmux_pane_id may be set or null)
- **AND** agent `alice` is registered in the same team as `bob`
- **WHEN** `alice` calls `poke({target_agent_id: 'bob', prompt: 'check inbox'})`
- **THEN** the poke response is `{ok: true, transport_used: 'claude-channel', channel_session_id: 'csid-bob'}`
- **AND** the channel proxy's host-facing stdio emits a `notifications/claude/channel` JSON-RPC notification
- **AND** no tmux command is executed
