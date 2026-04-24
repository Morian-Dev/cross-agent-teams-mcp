# claude-channel-transport Specification

## Purpose

Deliver agent wake-ups via Claude Code's experimental `claude/channel` MCP capability instead of (or in addition to) tmux paste injection.  A per-directory channel proxy subprocess declares the capability to its host Claude Code, subscribes to daemon wake-up notifications keyed by a `channel_session_id`, and relays them into the host's context as `<channel>` tags — removing the tmux dependency for poke delivery.
## Requirements
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
5. Otherwise the daemon SHALL write the caller's delivery as `{kind: 'claude-channel', channel_session_id: <csid>}` via the `agent-delivery` persistence rules, i.e. `UPDATE agents SET delivery_kind='claude-channel', delivery_payload=json_object('channel_session_id', <csid>) WHERE agent_id = <caller's agent_id>`, and return `{ok: true}`.  The daemon MUST NOT `UPDATE agents.channel_session_id` directly; that column is now a legacy derived value, see `agent-registry/spec.md`.

The tool's input schema, output schema, and caller-facing error codes are unchanged from the pre-refactor contract; only the underlying persistence target moves from the legacy `channel_session_id` column to the `delivery_kind` / `delivery_payload` pair.

#### Scenario: bind_channel updates caller's agents row when csid has live sink

- **GIVEN** agent `alice` exists with `delivery={kind: 'none'}` and is the MCP session caller
- **AND** a proxy session has attached a `ChannelWakeFanout` sink under `csid-abc`
- **WHEN** alice invokes `bind_channel({channel_session_id: 'csid-abc'})`
- **THEN** the response is `{ok: true}`
- **AND** the agents row for alice has `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`
- **AND** the derived `channel_session_id` for alice, via `list_agents`, is `'csid-abc'`

#### Scenario: bind_channel rejects unknown channel_session_id

- **GIVEN** agent `alice` is the MCP session caller
- **AND** no `ChannelWakeFanout` sink is attached under `csid-ghost`
- **WHEN** alice invokes `bind_channel({channel_session_id: 'csid-ghost'})`
- **THEN** the response is `{error: 'unknown_channel_session'}`
- **AND** the agents row for alice is unchanged, with `delivery_kind` and `delivery_payload` both at their prior values

#### Scenario: bind_channel rejects proxy caller

- **GIVEN** a caller registered with `role='__channel_proxy__'`
- **AND** a `ChannelWakeFanout` sink is attached under `csid-abc`
- **WHEN** the proxy caller invokes `bind_channel({channel_session_id: 'csid-abc'})`
- **THEN** the response is `{error: 'forbidden_role'}`

#### Scenario: bind_channel does not touch legacy channel_session_id column

- **GIVEN** agent `alice` exists with `delivery={kind: 'none'}` and `channel_session_id IS NULL` on the legacy column
- **AND** a `ChannelWakeFanout` sink is attached under `csid-abc`
- **WHEN** alice invokes `bind_channel({channel_session_id: 'csid-abc'})` and it returns `{ok: true}`
- **THEN** the legacy `channel_session_id` column for alice is still `NULL`
- **AND** the `delivery_kind` column is `'claude-channel'`

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

1. Parse CLI args: `--daemon-url <url>` (or env `CROSS_AGENT_TEAMS_MCP_DAEMON_URL`).  The proxy is identity-agnostic — it MUST NOT accept `--agent-team` or `--agent-name`.  If daemon-url is missing, exit with a non-zero status and a diagnostic on stderr.
2. Generate a fresh UUID v4 as `channel_session_id` for this process lifetime.  No persistence — each proxy startup gets a new csid.  (Rationale: the proxy is shared-by-directory in `.mcp.json`, so persisting by identity would collide across multi-instance Claude Code runs; a fresh csid per startup sidesteps the issue entirely.)
3. Open an MCP Streamable HTTP client to `<daemon-url>`.
4. Call `register_agent({client: 'custom', client_name: 'cross-agent-teams-channel', role: '__channel_proxy__', name: 'channel-proxy-<pid>', team: 'default', model: 'proxy', claude_ui_pid: <process.ppid>, delivery: {kind: 'claude-channel', channel_session_id: <csid>}})` to establish its own MCP session identity AND persist both the parent Claude Code UI pid and the current csid on the proxy's own agents row.  The `claude_ui_pid` value SHALL be the proxy process's parent pid at startup.  The `delivery` field reuses the existing `register_agent` delivery contract to persist the csid without adding a new column.
5. Call `subscribe_channel_wake({channel_session_id: <csid>})` to attach its notification sink.
6. Emit a `notifications/claude/channel` JSON-RPC notification on its host stdio telling Claude: its `channel_session_id` is `<csid>` and it should call `bind_channel({channel_session_id: '<csid>'})` to complete binding.  This notification remains for backward compatibility — callers that already know how to parse and use it are unaffected — but it is no longer required for auto-binding to succeed (see `agent-registry`'s auto-bind requirement).
7. Enter an idle loop receiving `notifications/channel_wake` from the daemon and relaying them to the host.

#### Scenario: proxy generates fresh csid on every startup

- **GIVEN** a proxy binary
- **WHEN** the proxy starts with `--daemon-url http://localhost:8787`
- **THEN** the proxy generates a fresh UUID v4 as its `channel_session_id`
- **AND** does NOT read or write any persistence file

#### Scenario: proxy registers its parent pid and csid on the daemon

- **GIVEN** the proxy binary starts with `--daemon-url http://localhost:8787`
- **AND** the proxy process's `ppid` is `25424`
- **AND** the proxy's freshly-generated csid is `'csid-abc'`
- **WHEN** the proxy performs its `register_agent` call during startup
- **THEN** the call arguments include `claude_ui_pid: 25424`
- **AND** the call arguments include `delivery: {kind: 'claude-channel', channel_session_id: 'csid-abc'}`
- **AND** after the call returns, the proxy's agents row has `claude_ui_pid=25424` and `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`

#### Scenario: proxy emits startup channel notification with csid and bind instruction

- **GIVEN** the proxy has completed `register_agent` and `subscribe_channel_wake` successfully with `channel_session_id='csid-xyz'`
- **WHEN** the proxy is about to enter its idle loop
- **THEN** the proxy emits a `notifications/claude/channel` JSON-RPC notification to its host
- **AND** the notification `params.content` contains the literal string `csid-xyz`
- **AND** the notification `params.content` mentions `bind_channel`

#### Scenario: proxy honors CROSS_AGENT_TEAMS_MCP_DAEMON_URL env var when flag omitted

- **GIVEN** the proxy binary is launched with no `--daemon-url` flag
- **AND** env var `CROSS_AGENT_TEAMS_MCP_DAEMON_URL=http://localhost:8787`
- **WHEN** the proxy starts
- **THEN** the proxy uses `http://localhost:8787` as its daemon URL
- **AND** does NOT read the legacy `TS_AGENT_TEAMS_DAEMON_URL` env var

#### Scenario: proxy exits when neither flag nor CROSS_AGENT_TEAMS_MCP_DAEMON_URL is set

- **GIVEN** the proxy binary is launched with no `--daemon-url` flag
- **AND** env var `CROSS_AGENT_TEAMS_MCP_DAEMON_URL` is unset or empty
- **WHEN** the proxy starts
- **THEN** the proxy exits with non-zero status
- **AND** stderr mentions `CROSS_AGENT_TEAMS_MCP_DAEMON_URL` (so operator knows what env var to set)

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

### Requirement: Channel proxy MCP server identity

The channel proxy's `McpServer` instance SHALL declare its `name` field as `cross-agent-teams-channel` during MCP initialize handshake with its host.  The internal daemon-facing `Client` instance SHALL declare its `name` field as `cross-agent-teams-proxy` (matching the bin name exposed to users).

#### Scenario: proxy serverInfo.name reports new brand to host

- **GIVEN** the proxy is started and an MCP client completes initialize over its stdio
- **THEN** the `serverInfo.name` field equals `cross-agent-teams-channel`

### Requirement: Proxy registration triggers reactive rebind of matching hosts

When an `__channel_proxy__` row is UPSERTed via `register_agent` and carries both a non-null `claude_ui_pid` and a `delivery.kind='claude-channel'` payload, the daemon SHALL, in the same transaction that writes the proxy row, look up hosts in the proxy's team that share the same UI ancestor AND are either unbound or bound to a stale csid.  Concretely, after writing the proxy row with `claude_ui_pid=P` and `delivery.channel_session_id=C_new`, the daemon SHALL execute:

```sql
UPDATE agents
SET delivery_kind='claude-channel',
    delivery_payload=json_object('channel_session_id', :C_new)
WHERE role != '__channel_proxy__'
  AND runtime_ui_pid = :P
  AND team = :proxy_team
  AND (
    delivery_kind = 'none'
    OR (delivery_kind = 'claude-channel'
        AND json_extract(delivery_payload, '$.channel_session_id') != :C_new)
  );
```

Hosts whose `runtime_ui_pid` was never persisted (e.g. callers that did not supply `ui_pid` on register) MUST NOT be rebinded — auto-bind requires an explicit ui_pid evidence trail.  Hosts bound to a different non-claude-channel delivery (`codex-appserver`, etc.) MUST NOT be touched.

This requirement covers two scenarios transparently:

1. **Host-first race**: host registered before the proxy was up; its row was left at `delivery.kind='none'`; proxy registration now backfills it.
2. **Proxy restart**: proxy restarted with a new csid; hosts previously bound to the old csid get rewritten to the new one.

#### Scenario: reactive rebind promotes host from 'none' to claude-channel

- **GIVEN** agent `alice` is registered in team `default` with `role='worker'`, `runtime_ui_pid=25424`, and `delivery_kind='none'`
- **AND** no `__channel_proxy__` row exists yet for `claude_ui_pid=25424`
- **WHEN** the channel proxy calls `register_agent({client:'custom', role:'__channel_proxy__', name:'channel-proxy-27245', team:'default', model:'proxy', claude_ui_pid:25424, delivery:{kind:'claude-channel', channel_session_id:'csid-new'}})`
- **THEN** the proxy row is written successfully
- **AND** alice's `agents` row has `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-new\"}'`

#### Scenario: reactive rebind rewrites stale csid on proxy restart

- **GIVEN** agent `alice` is registered in team `default` with `runtime_ui_pid=25424` and `delivery={kind:'claude-channel', channel_session_id:'csid-old'}`
- **AND** a previous `__channel_proxy__` row exists with `claude_ui_pid=25424` and `delivery.channel_session_id='csid-old'`
- **WHEN** the proxy (new process, same parent UI) calls `register_agent({..., claude_ui_pid:25424, delivery:{kind:'claude-channel', channel_session_id:'csid-new'}})`
- **THEN** the proxy row is UPSERTed with the new csid
- **AND** alice's row has `delivery_payload='{\"channel_session_id\":\"csid-new\"}'`

#### Scenario: reactive rebind does not touch hosts without runtime_ui_pid

- **GIVEN** agent `bob` is registered in team `default` with `runtime_ui_pid IS NULL` and `delivery_kind='none'`
- **WHEN** the proxy calls `register_agent({..., claude_ui_pid:25424, delivery:{kind:'claude-channel', channel_session_id:'csid-new'}})`
- **THEN** bob's row is unchanged (still `delivery_kind='none'`)

#### Scenario: reactive rebind does not overwrite non-claude delivery

- **GIVEN** agent `carol` is registered in team `default` with `runtime_ui_pid=25424` and `delivery_kind='codex-appserver'`
- **WHEN** the proxy calls `register_agent({..., claude_ui_pid:25424, delivery:{kind:'claude-channel', channel_session_id:'csid-new'}})`
- **THEN** carol's row still has `delivery_kind='codex-appserver'` (not overwritten)

#### Scenario: reactive rebind is scoped to the proxy's team

- **GIVEN** agent `dave` is registered in team `alpha` with `runtime_ui_pid=25424` and `delivery_kind='none'`
- **WHEN** the proxy calls `register_agent({..., team:'default', claude_ui_pid:25424, delivery:{kind:'claude-channel', channel_session_id:'csid-new'}})`
- **THEN** dave's row in team `alpha` is unchanged (still `delivery_kind='none'`)
