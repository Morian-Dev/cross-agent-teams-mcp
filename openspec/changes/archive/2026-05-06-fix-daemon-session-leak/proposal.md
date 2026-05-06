## Why

Empirical heap profiling shows daemon RSS grows ~3.7 MB/s under typical multi-host conditions, hitting V8 OOM (~4 GB) within ~20 minutes. The cause is a feedback loop: the channel proxy's 200 ms `waitForDisconnect` echo heartbeat occasionally trips on transient errors and triggers `runRegistrationSequence` to rebuild its MCP session; the rebuilt session collides with the existing `(team, name)` binding in `register-agent.ts`, returns `agent_id_collision`, the proxy retries every 500 ms, and every retry creates a fresh MCP session on the daemon side that is never reaped — sessions Map only sheds entries on explicit DELETE, which no client sends. Across N proxies this generates ~19 phantom sessions/sec, each retaining ~25 tool registrations + zod schemas + closures (~400 KB).

## What Changes

- **BREAKING**: `register_agent` no longer returns `agent_id_collision` when the same `(team, name)` re-registers from a different MCP session id. The new connection takeover semantics are: daemon releases the old binding, **closes the old MCP transport** (which propagates onclose → sessions Map cleanup), then accepts the new registration.
- Daemon adds a session-level garbage collector for orphan sessions: any MCP session whose `agentIdHolder.current` is still `undefined` more than 60 seconds after `onsessioninitialized` fires is force-closed. Sessions that successfully completed `register_agent` are NEVER touched.
- Channel proxy `waitForDisconnect` default heartbeat interval changes from 200 ms to 30 000 ms. `transport.onclose` remains the primary disconnect signal; echo polling is a coarse-grained liveness backstop, not a tight loop.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `agent-registry`: registration with an existing `(team, name)` from a NEW connection is now a takeover (release + close old session) instead of an error.
- `mcp-transport`: introduces orphan-session GC keyed on whether `register_agent` ever succeeded for that session.
- `claude-channel-transport`: `waitForDisconnect` heartbeat default raised from 200 ms to 30 s.

## Impact

- **Source files**:
  - `src/mcp/register-agent.ts` (collision → takeover)
  - `src/mcp/transport.ts` (sessions Map, onclose chain, GC ticker; new dependency: ability to look up a session by old connection_id when takeover fires)
  - `src/daemon/server.ts` (wire GC ticker into Fastify lifecycle alongside cleanup ticker)
  - `plugins/cross-agent-teams-channel/src/daemon-client.ts` (default `healthCheckIntervalMs` 200 → 30000)
- **Tests**:
  - new: orphan GC closes phantom session; takeover replaces existing binding and closes prior transport
  - update: any test asserting `agent_id_collision` for same-(team,name)-different-connection becomes a takeover assertion
- **Public-facing behaviour**:
  - Existing user-facing sessions (Claude Code, Codex, opencode primary MCP) are unaffected — they register once and the orphan-GC criterion (`agentIdHolder.current === undefined`) never matches them.
  - Channel proxies see a slower heartbeat (30 s) — daemon-down detection latency rises from sub-second to ~30 s, which is acceptable because `transport.onclose` already covers fast TCP-level breakage.
  - API consumers that previously relied on `agent_id_collision` as a guard against double-registration MUST treat the second `register_agent` as success returning the new agent_id and assume the prior session is closed.
