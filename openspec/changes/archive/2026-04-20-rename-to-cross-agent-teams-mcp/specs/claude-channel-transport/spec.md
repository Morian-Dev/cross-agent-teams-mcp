## ADDED Requirements

### Requirement: Channel proxy MCP server identity

The channel proxy's `McpServer` instance SHALL declare its `name` field as `cross-agent-teams-channel` during MCP initialize handshake with its host.  The internal daemon-facing `Client` instance SHALL declare its `name` field as `cross-agent-teams-proxy` (matching the bin name exposed to users).

#### Scenario: proxy serverInfo.name reports new brand to host

- **GIVEN** the proxy is started and an MCP client completes initialize over its stdio
- **THEN** the `serverInfo.name` field equals `cross-agent-teams-channel`

## MODIFIED Requirements

### Requirement: Channel proxy startup sequence

On startup, the channel proxy SHALL, in order:

1. Parse CLI args: `--daemon-url <url>` (or env `CROSS_AGENT_TEAMS_MCP_DAEMON_URL`).  The proxy is identity-agnostic — it MUST NOT accept `--agent-team` or `--agent-name`.  If daemon-url is missing, exit with a non-zero status and a diagnostic on stderr.
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
