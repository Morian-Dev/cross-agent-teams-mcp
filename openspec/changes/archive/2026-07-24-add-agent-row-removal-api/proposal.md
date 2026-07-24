# Proposal: add-agent-row-removal-api

## Why

There is no supported way to remove another agent's registry row. `unregister_self` only operates on the caller's own identity, and `runCleanup` only prunes 30-day-old mailbox rows and stale `__channel_proxy__` entries. Regular `agents` rows have no removal path at all.

This is not theoretical. On 2026-07-20 four stale kimi-code rows had to be cleared, and the only available method was editing `~/.cross-agent-teams-mcp/data.db` with `sqlite3` while the daemon was live. An operation that requires hand-editing the database is a missing API, and doing it by hand risks writing to a WAL-mode database that the daemon holds open.

Removal is genuinely needed even though `register_agent` upserts on `(device, team, name)`: an upsert only helps when the *same* identity re-registers. It does nothing for rows whose name was a typo (`kimi-teser`), for one-off test agents, or for rows carrying a stale device label that the owning device will never present again.

## What Changes

- Add `DELETE /api/agents/:agent_id` to the loopback-only REST surface. On success it returns the removed row's identity; an unknown id returns HTTP 404 `unknown_agent`.
- Extract the existing `findById` + `deleteById` body of `UnregisterSelfService.unregister` into a shared helper so the REST route and the MCP tool remove rows through one code path.
- Document the endpoint, and document explicitly that removal is a **registry** operation and NOT a way to stop an agent.

Deliberately NOT in scope:

- **No MCP tool.** An `unregister_agent({agent_id})` tool would let any agent remove a teammate's registration, including across devices. That is an unrequested capability expansion with a real abuse surface, and nothing in the motivating case needed it. `unregister_self` stays the only agent-initiated removal.
- **No liveness gate.** The endpoint does not refuse to remove a row that looks online. For kimi-code `online` is effectively always true (no `runtime_ui_pid`, no `tmux_pane_id`, so `isAgentLive` falls back to a 4-day `last_seen_at` window), so gating on it would block exactly the rows most in need of cleanup.

## Capabilities

### Modified Capabilities

- `rest-fallback-api`: the loopback REST surface gains a fourth endpoint, `DELETE /api/agents/:agent_id`, under the same origin gate and the same zero-session-side-effect invariant as the existing three.
- `agent-registry`: registry-row removal gains a second, operator-facing entry point alongside `unregister_self`, with explicit semantics for what removal does and does not do to a running agent.

## Impact

- `src/daemon/rest-api.ts`: new route + handler, mounted alongside the existing three.
- `src/mcp/unregister-self.ts`: extract the shared removal helper; `UnregisterSelfService` keeps its current behaviour and error vocabulary.
- `README.md` / `README.zh-CN.md`: document the endpoint in the REST fallback section.
- No schema change. `AgentsRepo.deleteById` already exists and is reused as-is.
