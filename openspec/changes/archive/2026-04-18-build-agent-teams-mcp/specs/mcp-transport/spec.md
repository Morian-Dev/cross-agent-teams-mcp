## ADDED Requirements

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
