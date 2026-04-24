# mcp-transport Specification

## Purpose

Expose the MCP Streamable HTTP transport, manage per-session identifiers, and provide the built-in `echo` tool plus Phase 0 three-agent connectivity coverage.
## Requirements
### Requirement: MCP Streamable HTTP transport mount

The daemon SHALL expose the MCP Streamable HTTP endpoint at `POST /mcp` using `@modelcontextprotocol/sdk` server transport. The endpoint MUST accept JSON-RPC 2.0 framed requests and MAY upgrade to SSE for server→client streaming per the 2025 MCP spec.

#### Scenario: MCP initialize succeeds

- **WHEN** an MCP client sends `initialize` to `POST /mcp`
- **THEN** the daemon returns a valid JSON-RPC response with `protocolVersion` and `capabilities.tools` set

### Requirement: Session id assignment

The transport SHALL assign a unique session id (UUID v4) to every new MCP HTTP session and surface it via the `Mcp-Session-Id` response header. Subsequent requests from the same client MUST include that header, and the daemon MUST reject requests whose session id is unknown with HTTP 400 `{ "error": "unknown_session" }`.

#### Scenario: Two clients receive distinct session ids

- **WHEN** two independent MCP clients call `initialize`
- **THEN** each receives a different `Mcp-Session-Id` header value

#### Scenario: Follow-up request with unknown session id

- **WHEN** a client sends a tool call with `Mcp-Session-Id: <random-uuid-never-issued>`
- **THEN** response status is 400 and body is `{ "error": "unknown_session" }`

### Requirement: Echo tool for connectivity probing

The daemon SHALL register a built-in tool `echo(msg: string)` that returns `{ msg, echoed_at: <ISO8601 timestamp> }`. This tool is unauthenticated by the tool layer (auth applies at transport layer only) and is used to confirm three-way MCP client compatibility before any business tool is shipped.

#### Scenario: Echo returns input and timestamp

- **WHEN** client calls `echo({ msg: "hi" })`
- **THEN** response is `{ msg: "hi", echoed_at: <valid ISO8601> }`

### Requirement: Three-agent Phase 0 connectivity

Before any business tool is released, the project SHALL include an automated Phase 0 connectivity test that starts the daemon and drives three MCP clients simulating opencode, Claude Code, and Codex CLI over Streamable HTTP. All three MUST successfully call `echo` within the same daemon session.

#### Scenario: All three agents connect and echo

- **GIVEN** daemon started on a random free port
- **WHEN** three MCP clients (opencode-style, Claude-Code-style, Codex-CLI-style) each open a Streamable HTTP session and call `echo({ msg: "<role>" })`
- **THEN** each client receives the correct echoed message
- **AND** `list_agents` (once Phase 1 exists) returns three distinct agent_id values

### Requirement: SSE fanout keyed by agent_id, attached after register_agent

The SSE fanout sink for an MCP session SHALL be attached to `SseFanout` keyed by the session's final `agent_id` (as returned by `register_agent`), **not** by the MCP session id. Attachment MUST be deferred until the first successful `register_agent` call on that session.

When `register_agent` succeeds and returns `agent_id=X`:

1. If another sink is currently attached under key `X` (e.g. from a prior session that reused the same identity), the transport MUST `fanout.detach(X)` on the old sink before attaching the new one.
2. The transport MUST call `fanout.attach(X, team, sink)` with `sink` bound to the current session's `StreamableHTTPServerTransport`.
3. The transport MUST update `agentIdHolder.current = X` so subsequent `from_agent_id` spoof checks compare against `X`.

When an MCP session closes (`transport.onclose`):

1. If the session had completed registration (i.e. `agentIdHolder.current` is set), the transport MUST `fanout.detach(agentIdHolder.current)`.
2. If the session closed before any successful `register_agent`, the transport MUST perform no fanout detach (there was nothing attached).

#### Scenario: Fanout attached after register_agent, not at session init

- **GIVEN** a freshly initialized MCP session with session id `sess-A` and no `register_agent` yet
- **WHEN** an internal caller inspects `SseFanout` state
- **THEN** no sink is attached under key `sess-A`
- **AND** no sink is attached under any key originating from this session

#### Scenario: Register triggers fanout attach under returned agent_id

- **GIVEN** a session `sess-A` that calls `register_agent` and receives `agent_id='X'`
- **WHEN** the tool call completes
- **THEN** `SseFanout` has exactly one sink attached under key `'X'`
- **AND** no sink is attached under key `sess-A`

#### Scenario: Cross-session reuse replaces prior sink

- **GIVEN** session `sess-A` registered `(default, alice, backend)` and holds the sink attached under `agent_id='X'`
- **WHEN** a new session `sess-B` registers the same identity and also receives `agent_id='X'`
- **THEN** the fanout sink for `X` is now `sess-B`'s transport
- **AND** `sess-A`'s old sink was detached before `sess-B`'s attach (net: exactly one sink under `X`)
- **AND** subsequent `fanout.emit('X', event)` reaches `sess-B`'s SSE stream, not `sess-A`'s

#### Scenario: Session close detaches the agent_id sink

- **GIVEN** session `sess-A` is registered and holds sink under `agent_id='X'`
- **WHEN** the HTTP transport emits `onclose`
- **THEN** `SseFanout` has no sink attached under `'X'`

#### Scenario: Close before register is a no-op for fanout

- **GIVEN** a session that initialized but never successfully called `register_agent`
- **WHEN** the HTTP transport emits `onclose`
- **THEN** the fanout state is unchanged (no spurious detach, no error)

### Requirement: MCP server initialize returns instructions field with xats abbreviation and team-default convention

The daemon's `McpServer` instance SHALL declare a non-empty `instructions` field (via the `ServerOptions.instructions` constructor argument) so that every MCP session's `initialize` response exposes it to the calling client / LLM.  The `instructions` string MUST convey at least these two conventions, in any prose form the implementer chooses:

1. **Abbreviation**: `xats` is an abbreviation for `cross-agent-teams`; when users or other agents mention `xats`, they refer to this MCP server (the `cross-agent-teams-mcp` daemon) and its registered tools.
2. **Team default on registration**: when invoking `register_agent` or `register_claude_self`, if the end user has not explicitly specified a `team`, the LLM client SHOULD pass its current working directory as `project_dir` so the daemon can derive a project-scoped default team (instead of falling back to the global `'default'` team).

The `instructions` string MUST be a single plain string (the MCP protocol slot is not a list).  It MUST be present on every session; it MUST NOT be gated on runtime state.

#### Scenario: initialize response includes instructions string

- **GIVEN** a fresh MCP client connects to the daemon and performs `initialize`
- **THEN** the `initialize` response contains a non-empty `instructions` field whose value is a string

#### Scenario: instructions content mentions xats abbreviation

- **GIVEN** a fresh MCP client connects to the daemon and performs `initialize`
- **THEN** the `instructions` string contains the literal substring `xats`
- **AND** the `instructions` string contains the literal substring `cross-agent-teams`

#### Scenario: instructions content mentions project_dir team default convention

- **GIVEN** a fresh MCP client connects to the daemon and performs `initialize`
- **THEN** the `instructions` string contains the literal substring `project_dir`
- **AND** the `instructions` string mentions (case-insensitively) both `team` and the intent of using the current working directory when `team` is unspecified

