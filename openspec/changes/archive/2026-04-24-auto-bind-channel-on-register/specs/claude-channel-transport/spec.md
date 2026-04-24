## MODIFIED Requirements

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

## ADDED Requirements

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
