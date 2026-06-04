## Why

After a Claude Code context clear, the agent forgets its own `(team, name)` identity, yet the daemon still holds the registration row. The user wants a single "reconnect xats" command that recovers the prior identity automatically, using the only stable live handle that survives a context clear: the Claude UI process id (`$PPID`, stored as `runtime_ui_pid`). Today there is no tool that maps `ui_pid -> identity`, so the agent is forced to re-ask the user for its name.

## What Changes

- Add a new MCP tool `reconnect({ ui_pid })` that looks up the most recent `local`-device agent row whose `runtime_ui_pid` matches `ui_pid`, then re-establishes that identity (cross-session takeover + channel/pane auto-bind) by reusing the existing registration path.
- On a single match: reuse the existing `agent_id`, refresh `last_seen_at`, re-bind the channel and runtime pane via the same `ui_pid`-driven mechanisms `register_agent` already uses, and return `{ ok, agent_id, name, team, channel_session_id }`.
- On zero matches: return a `need_register` envelope guiding the caller to do a normal `register_agent` (single responsibility — `reconnect` does not fall back to registering).
- On multiple matches (e.g. the same UI process previously registered under two different names): return an `ambiguous` envelope with candidates ordered by `last_seen_at` descending, so the agent can let the user choose.
- Add tool-description guidance so the agent invokes `reconnect` when the user says "reconnect xats", "re-register xats", "重连 xats", or "重新注册 xats".

## Capabilities

### New Capabilities
- `agent-reconnect`: ui_pid-based identity recovery — a `reconnect` MCP tool that restores a prior `(team, name)` registration after a context clear by reverse-looking-up `runtime_ui_pid`, with single-match reuse, zero-match guidance, and multi-match disambiguation.

### Modified Capabilities
<!-- None. reconnect reads the existing runtime_ui_pid column; no agents-table schema change. -->

## Impact

- New file under `src/mcp/` for the reconnect tool handler, wired into the MCP tools registry (`src/mcp/tools.ts`).
- New reverse-lookup query in `src/storage/agents-repo.ts` (`findByRuntimeUiPid` returning rows ordered by `last_seen_at desc`), reusing the existing `runtime_ui_pid` column and the same SQL shape as `rebindHostsByClaudeUiPid`.
- Reuses existing cross-session takeover, `auto_bind_channel`, and `auto_bind_runtime_identity` logic — no changes to channel/pane binding internals.
- No database schema migration (the `runtime_ui_pid` column already exists).
- Scope limited to `agent_type: 'claude-code'` and `device: 'local'`; codex (thread_id-based) reconnect is explicitly out of scope.
