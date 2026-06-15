## MODIFIED Requirements

### Requirement: Channel proxy startup sequence

On startup, the channel proxy SHALL, in order:

1. Parse CLI args: `--daemon-url <url>` (or env `CROSS_AGENT_TEAMS_MCP_DAEMON_URL`).  The proxy is identity-agnostic — it MUST NOT accept `--agent-team` or `--agent-name`.  If daemon-url is missing, exit with a non-zero status and a diagnostic on stderr.
2. Generate a fresh UUID v4 as `channel_session_id` for this process lifetime.  No persistence — each proxy startup gets a new csid.  (Rationale: the proxy is shared-by-directory in `.mcp.json`, so persisting by identity would collide across multi-instance Claude Code runs; a fresh csid per startup sidesteps the issue entirely.)
3. Open an MCP Streamable HTTP client to `<daemon-url>`.
4. Call `register_agent({agent_type: 'custom', agent_type_name: 'cross-agent-teams-channel', role: '__channel_proxy__', name: 'channel-proxy-<pid>', team: 'default', model: 'proxy', claude_ui_pid: <process.ppid>, delivery: {kind: 'claude-channel', channel_session_id: <csid>}})` to establish its own MCP session identity AND persist both the parent Claude Code UI pid and the current csid on the proxy's own agents row.  The `claude_ui_pid` value SHALL be the proxy process's parent pid at startup.  The `delivery` field reuses the existing `register_agent` delivery contract to persist the csid without adding a new column.
5. Call `subscribe_channel_wake({channel_session_id: <csid>})` to attach its notification sink.
6. Emit a `notifications/claude/channel` JSON-RPC notification on its host stdio telling Claude its `channel_session_id` is `<csid>` and how to (re)establish on this session. The notification SHALL route re-establishment by **whether the host agent still remembers its own `(team, name)`**, NOT by whether `$PPID` is unchanged (a condition the agent cannot self-evaluate):
   - If the agent does NOT remember its `(team, name)` (for example reconnecting after a context clear, where `$PPID` is unchanged), the notification MUST guide `reconnect({ui_pid: $PPID})` (recovers the prior identity by process id and rebinds the new csid in one step); on a `need_register` result it asks the user.
   - If the agent DOES remember its `(team, name)` (for example after closing Claude Code and resuming the conversation, where `$PPID` has changed but the context survived), the notification MUST guide `register_agent` with the remembered `(team, name)` and the current `$PPID`, and instruct the agent to state in its reply which identity it re-registered as — because `reconnect` would reverse-look-up the changed `$PPID`, find no match, and return `need_register`.
   - It MUST state that `bind_channel({channel_session_id: '<csid>'})` only rebinds when the caller's current MCP session is already bound to its agent and otherwise returns `unknown_agent`.

   This notification remains for backward compatibility — callers that already know how to parse and use it are unaffected — but it is no longer required for auto-binding to succeed (see `agent-registry`'s auto-bind requirement).
7. Enter an idle loop receiving `notifications/channel_wake` from the daemon and relaying them to the host.

If `register_agent` or `subscribe_channel_wake` fails after the Streamable HTTP MCP
session has been initialized, the proxy MUST terminate the daemon-facing MCP session
before retrying.  Termination MUST use the Streamable HTTP session termination path
(HTTP `DELETE` via the SDK transport), not only local client close, so the daemon can
drop the unregistered session immediately.

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

#### Scenario: proxy emits startup channel notification with csid and case-routed bind instruction

- **GIVEN** the proxy has completed `register_agent` and `subscribe_channel_wake` successfully with `channel_session_id='csid-xyz'`
- **WHEN** the proxy is about to enter its idle loop
- **THEN** the proxy emits a `notifications/claude/channel` JSON-RPC notification to its host
- **AND** the notification `params.content` contains the literal string `csid-xyz`
- **AND** the notification `params.content` mentions `bind_channel`
- **AND** the notification `params.content` guides `reconnect({ui_pid: $PPID})` for the case where the agent does NOT remember its `(team, name)` (context clear)
- **AND** the notification `params.content` guides `register_agent` with the remembered `(team, name)` for the case where the agent DOES remember it after a restart + resume (changed `$PPID`)
- **AND** the notification `params.content` does NOT condition the reconnect path on `$PPID` being unchanged as the sole router

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

#### Scenario: proxy terminates daemon MCP session after registration failure

- **GIVEN** the proxy has initialized a daemon-facing Streamable HTTP MCP session
- **AND** the daemon rejects the proxy's `register_agent` call
- **WHEN** the proxy handles that registration failure
- **THEN** it terminates the MCP session via Streamable HTTP session termination
- **AND** the daemon's orphan MCP session count returns to its prior value
