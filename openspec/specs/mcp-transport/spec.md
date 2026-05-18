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
2. **Team default on registration**: when invoking `register_agent`, if the end user has not explicitly specified a `team`, the LLM client SHOULD pass its current working directory as `project_dir` so the daemon can derive a project-scoped default team (instead of falling back to the global `'default'` team).

The `instructions` string MUST be a single plain string (the MCP protocol slot is not a list).  It MUST be present on every session; it MUST NOT be gated on runtime state.  The string MUST NOT name `register_claude_self` or `register_codex_self` (those tools are removed; see `agent-registry`'s "register_claude_self and register_codex_self tools removed from MCP tool surface" requirement).

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

#### Scenario: instructions do not name removed self tools

- **GIVEN** a fresh MCP client connects to the daemon and performs `initialize`
- **THEN** the `instructions` string does NOT contain the literal substring `register_claude_self`
- **AND** the `instructions` string does NOT contain the literal substring `register_codex_self`

### Requirement: MCP server instructions field includes anti-pattern paragraph forbidding list_agents pre-check before send_message

The daemon's `McpServer` `instructions` field (declared via `ServerOptions.instructions`, exposed in every session's `initialize` response per the existing "MCP server initialize returns instructions field" requirement) SHALL contain a server-level anti-pattern paragraph that reinforces the per-tool description rules introduced for `list_agents` and `send_message`. The prose may be reworded, but the `instructions` string MUST contain all of:

1. The literal substring `list_agents`.
2. The literal substring `send_message`.
3. The literal substring `unknown_recipient`.
4. A directive forbidding using `list_agents` to pre-verify a recipient before `send_message` (case-insensitive match on `DO NOT` / `MUST NOT` together with `pre` within the same sentence as `list_agents`).
5. A statement that `list_agents` is caller-team scoped and cannot see cross-team agents (case-insensitive match on `caller`'s team or `caller-team` together with prose declaring inability to see other teams).

The directive SHALL appear as part of the existing single `instructions` string — no new instructions slot is introduced. The paragraph SHALL coexist with the previously specified content (xats abbreviation, project_dir team default) without removing or contradicting it.

#### Scenario: instructions string contains the anti-pattern paragraph

- **GIVEN** an MCP client opens a session and receives the `initialize` response
- **WHEN** the response's `instructions` field is inspected
- **THEN** the string contains the literal substring `list_agents`
- **AND** the string contains the literal substring `send_message`
- **AND** the string contains the literal substring `unknown_recipient`

#### Scenario: instructions string uses jussive prose for the pre-check ban

- **GIVEN** an MCP client opens a session and receives the `initialize` response
- **WHEN** the response's `instructions` field is inspected
- **THEN** the string contains directive prose forbidding pre-verification (case-insensitive match on `DO NOT` or `MUST NOT` together with `pre` within the same sentence as `list_agents`)

#### Scenario: instructions string declares list_agents caller-team scope at server level

- **GIVEN** an MCP client opens a session and receives the `initialize` response
- **WHEN** the response's `instructions` field is inspected
- **THEN** the string declares that `list_agents` is scoped to the caller's team and cannot see cross-team agents (case-insensitive match on `caller`'s team or `caller-team`, together with prose stating inability to see other teams)

#### Scenario: instructions string preserves existing required content

- **GIVEN** an MCP client opens a session and receives the `initialize` response
- **WHEN** the response's `instructions` field is inspected
- **THEN** the string still contains the literal substring `xats`
- **AND** the string still contains the literal substring `cross-agent-teams`
- **AND** the string still contains the literal substring `project_dir`

### Requirement: Orphan session garbage collection

The daemon SHALL run a periodic ticker that walks the in-memory `sessions` Map maintained by `mountMcp` and force-closes unregistered sessions that exceed the configured idle window, max-age window, or unregistered-session count limit. The daemon MUST also enforce the unregistered-session count limit immediately after a new MCP session is initialized.

Each session MUST track a `lastActivityAt` timestamp. `lastActivityAt` MUST be initialized to the value of `createdAt` inside `onsessioninitialized`, and MUST be set to `Date.now()` whenever a POST, GET, or DELETE request matches that session (i.e. on every successful transport-level interaction). Requests that fail session lookup with `unknown_session` MUST NOT bump any timestamp.

A session is "orphan" if and only if:

1. `agentIdHolder.current === undefined` (no successful `register_agent` has bound an agent_id to the session yet).

An orphan session MUST be reaped when any of these conditions is true:

1. `Date.now() - session.lastActivityAt >= idleMs` (no transport-level activity within the idle grace window).
2. `Date.now() - session.createdAt >= maxAgeMs` (the session has remained unregistered beyond the max-age window, even if heartbeats keep it active).
3. The number of orphan sessions exceeds `maxSessions`; the daemon MUST reap the oldest orphan sessions first until the number of remaining orphans is at most `maxSessions`.

The default idle window SHALL be `300_000 ms` (5 minutes). The default MUST be overridable via the `ORPHAN_GC_IDLE_MS` environment variable or the `orphanGcIdleMs` `ServerOpts` field, both of which accept a positive integer (millisecond) value.

The default max-age window SHALL be `300_000 ms` (5 minutes). The default MUST be overridable via the `ORPHAN_GC_MAX_AGE_MS` environment variable or the `orphanGcMaxAgeMs` `ServerOpts` field, both of which accept a positive integer (millisecond) value.

The default orphan-session limit SHALL be `500`. The default MUST be overridable via the `ORPHAN_GC_MAX_SESSIONS` environment variable or the `orphanGcMaxSessions` `ServerOpts` field, both of which accept a positive integer value.

Force-closing an orphan session MUST invoke `session.transport.close()`. Closing the transport MUST propagate to the existing `onclose` chain so the session is removed from `sessions` Map, the SSE fanout binding is detached (if any), the channel-wake fanout binding is detached (if any), and the `sessionOwners` Authorization-hash binding is removed.

Sessions whose `agentIdHolder.current` is set (i.e. that have completed at least one successful `register_agent`) MUST NEVER be touched by this GC, regardless of how long they have been idle.

The GC tick interval MUST be at least 30 seconds (long enough that the GC itself does not contribute meaningful CPU pressure even with thousands of orphans). The default tick interval SHALL be 60 seconds.

The GC ticker MUST be cleared when the Fastify app emits `onClose`, alongside the existing cleanup ticker registered in `buildServer`.

The GC MUST emit a debug-level log line for each orphan it reaps, including the orphan's MCP session id, age in seconds, idle duration in seconds, and reap reason.

#### Scenario: Orphan session past idle grace is reaped

- **GIVEN** an MCP client opens a connection and the daemon assigns session `sess-X`
- **AND** the client never calls `register_agent` and issues no further transport-level requests
- **AND** the GC tick fires more than `graceMs` after `sess-X`'s `lastActivityAt`
- **WHEN** the GC walks the sessions Map
- **THEN** `sess-X` is force-closed (its transport's `close()` method invoked)
- **AND** `sess-X` is removed from the `sessions` Map after the onclose chain settles

#### Scenario: Activity bumps the idle clock and prevents reap

- **GIVEN** session `sess-W` was created and `agentIdHolder.current` is still `undefined`
- **AND** the client issues any matching POST/GET/DELETE on `sess-W` (e.g. a tool call) shortly before the GC tick
- **AND** `sess-W` is younger than `maxAgeMs`
- **AND** the orphan count is at or below `maxSessions`
- **WHEN** the GC tick fires within `idleMs` of that activity
- **THEN** `sess-W` is NOT force-closed
- **AND** `sess-W` remains in the `sessions` Map

#### Scenario: Active orphan past max age is reaped

- **GIVEN** session `sess-A` was created more than `maxAgeMs` ago
- **AND** `sess-A` has not completed `register_agent`
- **AND** the client recently issued a matching POST/GET/DELETE so `sess-A` is still within `idleMs`
- **WHEN** the GC tick fires
- **THEN** `sess-A` is force-closed
- **AND** the reap log reason is `max_age`

#### Scenario: Orphan cap reaps oldest unregistered sessions only

- **GIVEN** the daemon has more than `maxSessions` orphan sessions
- **AND** it also has registered sessions that may be long idle
- **WHEN** the GC tick fires
- **THEN** the daemon force-closes the oldest orphan sessions until at most `maxSessions` orphans remain
- **AND** registered sessions are not force-closed by this cap

#### Scenario: New orphan creation enforces cap immediately

- **GIVEN** the daemon already has `maxSessions` orphan sessions
- **WHEN** a new MCP session is initialized and remains unregistered
- **THEN** the daemon force-closes the oldest orphan session without waiting for the next GC tick
- **AND** the newly initialized session remains available

#### Scenario: Registered session is exempt from GC

- **GIVEN** session `sess-Y` called `register_agent` successfully one second after `initialize` 24 hours ago
- **AND** no further activity has occurred on `sess-Y` since then
- **WHEN** the GC tick fires
- **THEN** `sess-Y` is NOT force-closed
- **AND** `sess-Y` remains in the `sessions` Map

#### Scenario: Orphan session within grace is not yet reaped

- **GIVEN** session `sess-Z` was created 10 seconds ago with no subsequent activity
- **AND** `sess-Z`'s `agentIdHolder.current` is `undefined`
- **AND** the orphan count is at or below `maxSessions`
- **WHEN** the GC tick fires with the default 5-minute grace
- **THEN** `sess-Z` is NOT force-closed
- **AND** `sess-Z` remains in the `sessions` Map

#### Scenario: Reap propagates to fanout and channel bindings

- **GIVEN** an orphan session `sess-O` had registered an SSE fanout sink (e.g. via a half-completed registration path that bound the sink before failing) and a channel-wake sink
- **WHEN** the GC reaps `sess-O`
- **THEN** the SSE fanout no longer holds a sink for `sess-O`
- **AND** the channel-wake fanout no longer holds a sink for `sess-O`'s session id
