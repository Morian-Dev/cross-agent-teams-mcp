# Proposal: add-kimi-session-share-and-registry-logs

## Why

Joint testing on 2026-07-24 surfaced three binding-layer frictions, each observed live rather than hypothesized:

1. **Every poke to a kimi agent kills the TUI's MCP connection.** kimi's dual-engine architecture gives one logical agent two MCP connections (TUI in-process engine + server engine). The server-side turn wakes unbound, hits `unknown_agent`, re-registers under the same name — and because the takeover exception only recognizes codex `thread_id`, that re-register force-closes the TUI's connection. The TUI shows "MCP server closed unexpectedly", then steals the binding back on its next turn, and the next poke starts the cycle again: a binding ping-pong with a connection kill per poke.
2. **Silent binding loss is undiagnosable.** Client MCP transports rotate their session id (sometimes visibly via a channel re-attach, sometimes silently); the agent's next tool call lands on an unbound session and fails with `unknown_agent`. Root-causing one such incident today took a source-level forensic pass because the daemon log contains only startup banners: every session-created / session-closed / takeover / orphan-reap line the code already emits is dropped by the default no-op `log` sink (`opts.log?.()` with `mcpLog` never supplied).
3. **A kimi agent that lost its context cannot recover its identity.** `reconnect` supports claude-code (`ui_pid`), codex (`thread_id`), and opencode (`base_url`), but not kimi-code. A kimi server-side turn after a context clear has neither the launcher env nor conversational memory of its `session_id`, so it has no recovery path at all.

## What Changes

- **Share, don't take over, within one kimi session**: extend the takeover exception so that two registrations declaring `agent_type='kimi-code'` with validated `delivery.kind='kimi-server'` and the **same `session_id`** share the binding as concurrent connections — exactly the existing codex `thread_id` semantics. Different session ids, or any other agent type, still take over.
- **Land the existing lifecycle logs**: wire the daemon binary's `mcpLog` so session-created / session-closed / takeover / orphan-reap lines reach the daemon's log output. No new events — the emissions already exist and are already required by spec; only the sink is missing.
- **kimi reconnect**: `reconnect({ base_url, session_id })` recovers a kimi-code identity, revalidating the session against the kimi server before rebinding, mirroring the opencode shape.
- **Near-window proceed observability** (small, supports future window tuning): when a kimi poke proceeds and the wire log's age is below an observation ceiling, log a `kimi_poke_proceeded` record with `wire_age_ms`. The 10s gate window itself is unchanged by decision.

## Capabilities

### Modified Capabilities

- `agent-registry`: the takeover requirement's sharing exception grows a kimi-code arm keyed on `delivery.session_id`.

### Added Requirements to Existing Capabilities

- `daemon-core`: registry/session lifecycle events reach the daemon log.
- `agent-reconnect`: kimi-code recovery by `(base_url, session_id)` with server-side revalidation.
- `kimi-server-transport`: near-window proceeds log `wire_age_ms`.

## Impact

- `src/mcp/register-agent.ts`: `sharedRuntimeKey` gains a kimi branch (returns `delivery.session_id` for `kimi-code` + `kimi-server`).
- `src/cli.ts` / `src/daemon/server.ts`: supply a real `mcpLog` sink.
- `src/mcp/reconnect.ts`: kimi reverse lookup + revalidation branch.
- `src/mcp/kimi-server-dispatch.ts` / `kimi-session-state.ts`: expose wire age to the proceed path for the observability record.
- Tests mirror the existing codex-share and opencode-reconnect suites.

## Explicitly out of scope

- **claude-code auto-rebind after transport rotation.** Deliberately deferred: the lifecycle logs added here are the evidence base for deciding whether and how to build it. Until then the documented recovery stays "on `unknown_agent`, re-register".
- **Widening the 10s TUI-write window.** Decided against: a wider window delays every poke to a recently-active session, while thinking-gap silences can outlast any window. The new `wire_age_ms` records exist to revisit this with data.
- **Recycling shared bound sessions.** Bound sessions are exempt from orphan GC, so shared kimi connections accumulate — but kimi holds MCP connections per session instance (verified: `mcp.server.status=connected` fires once per resume, not per turn), so growth is a few per day, driven by cold resumes and TUI restarts. Documented as a known trait; a recycler is not warranted yet.
