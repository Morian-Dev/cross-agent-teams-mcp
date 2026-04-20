## MODIFIED Requirements

### Requirement: bind_channel MCP tool writes channel_session_id to caller's agents row

The daemon SHALL register an MCP tool `bind_channel({channel_session_id: string})` for self-binding a Claude Code host to its proxy's channel session.  The caller identity is resolved from the session (the MCP session is already bound to an `agent_id` via `register_agent`); `bind_channel` does NOT accept `team` or `name` arguments.  When invoked:

1. The caller MUST be a registered agent (session bound to an `agent_id`); otherwise return `{error: 'unknown_agent'}`.
2. The caller's `role` MUST NOT be `'__channel_proxy__'` (proxies never bind themselves as channel owners); non-proxy roles are all accepted.
3. `channel_session_id` MUST be a trimmed non-empty string; otherwise return `{error: 'invalid_channel_session_id'}`.
4. The `channel_session_id` MUST correspond to a currently-attached sink in `ChannelWakeFanout` (i.e. a live proxy session already called `subscribe_channel_wake` with this csid); otherwise return `{error: 'unknown_channel_session'}`.  This guards against Claude typing a random string and catches races where Claude tries to bind after the proxy session already closed.
5. Otherwise the daemon SHALL write the caller's delivery as `{kind: 'claude-channel', channel_session_id: <csid>}` via the `agent-delivery` persistence rules (i.e. `UPDATE agents SET delivery_kind='claude-channel', delivery_payload=json_object('channel_session_id', <csid>) WHERE agent_id = <caller's agent_id>`) and return `{ok: true}`.  The daemon MUST NOT `UPDATE agents.channel_session_id` directly; that column is now a legacy derived value (see `agent-registry/spec.md`).

The tool's input schema, output schema, and caller-facing error codes are unchanged from the pre-refactor contract; only the underlying persistence target moves from the legacy `channel_session_id` column to the `delivery_kind`/`delivery_payload` pair.

#### Scenario: bind_channel updates caller's agents row when csid has live sink

- **GIVEN** agent `alice` exists with `delivery={kind: 'none'}` and is the MCP session caller
- **AND** a proxy session has attached a `ChannelWakeFanout` sink under `csid-abc`
- **WHEN** alice invokes `bind_channel({channel_session_id: 'csid-abc'})`
- **THEN** the response is `{ok: true}`
- **AND** the agents row for alice has `delivery_kind='claude-channel'` and `delivery_payload='{"channel_session_id":"csid-abc"}'`
- **AND** the derived `channel_session_id` for alice (via `list_agents`) is `'csid-abc'`

#### Scenario: bind_channel rejects unknown channel_session_id

- **GIVEN** agent `alice` is the MCP session caller
- **AND** no `ChannelWakeFanout` sink is attached under `csid-ghost`
- **WHEN** alice invokes `bind_channel({channel_session_id: 'csid-ghost'})`
- **THEN** the response is `{error: 'unknown_channel_session'}`
- **AND** the agents row for alice is unchanged (`delivery_kind` and `delivery_payload` both at their prior values)

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
