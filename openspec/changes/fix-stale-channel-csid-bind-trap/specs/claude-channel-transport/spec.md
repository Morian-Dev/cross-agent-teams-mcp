## MODIFIED Requirements

### Requirement: Channel proxy startup sequence

On startup, the channel proxy SHALL, in order:

1. Parse CLI args: `--daemon-url <url>` (or env `CROSS_AGENT_TEAMS_MCP_DAEMON_URL`).  The proxy is identity-agnostic — it MUST NOT accept `--agent-team` or `--agent-name`.  If daemon-url is missing, exit with a non-zero status and a diagnostic on stderr.
2. Generate a fresh UUID v4 as `channel_session_id` for this process lifetime.  No persistence — each proxy startup gets a new csid.  (Rationale: the proxy is shared-by-directory in `.mcp.json`, so persisting by identity would collide across multi-instance Claude Code runs; a fresh csid per startup sidesteps the issue entirely.)
3. Open an MCP Streamable HTTP client to `<daemon-url>`.
4. Call `register_agent({client: 'custom', client_name: 'cross-agent-teams-channel', role: '__channel_proxy__', name: 'channel-proxy-<pid>', team: 'default', model: 'proxy', claude_ui_pid: <process.ppid>, delivery: {kind: 'claude-channel', channel_session_id: <csid>}})` to establish its own MCP session identity AND persist both the parent Claude Code UI pid and the current csid on the proxy's own agents row.  The `claude_ui_pid` value SHALL be the proxy process's parent pid at startup.  The `delivery` field reuses the existing `register_agent` delivery contract to persist the csid without adding a new column.
5. Call `subscribe_channel_wake({channel_session_id: <csid>})` to attach its notification sink.
6. Emit a `notifications/claude/channel` JSON-RPC notification on its host stdio telling Claude how to register against the daemon.  The notification content MUST contain the literal csid string (so operators and the `bind_channel` rebind path can reach it) and MUST recommend `register_claude_self({name, ui_pid: $PPID})` (or the equivalent `register_agent({client:'claude-code', name, model, ui_pid: $PPID})`) as the PRIMARY registration path.  The content MUST describe `bind_channel({channel_session_id: <csid>})` as the low-level rebind tool for already-registered hosts.  The content MUST NOT recommend passing `channel_session_id` as an argument to `register_claude_self` or `register_agent`.
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

#### Scenario: proxy emits startup channel notification recommending ui_pid-based registration

- **GIVEN** the proxy has completed `register_agent` and `subscribe_channel_wake` successfully with `channel_session_id='csid-xyz'`
- **WHEN** the proxy is about to enter its idle loop
- **THEN** the proxy emits a `notifications/claude/channel` JSON-RPC notification to its host
- **AND** the notification `params.content` contains the literal string `csid-xyz`
- **AND** the notification `params.content` mentions `register_claude_self`
- **AND** the notification `params.content` mentions `ui_pid`
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
