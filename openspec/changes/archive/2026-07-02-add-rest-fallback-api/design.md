## Context

The daemon (`src/daemon/server.ts` → `buildServer`) mounts exactly two HTTP surfaces: `/mcp` (via `mountMcp` in `src/mcp/transport.ts`) and `/health`. Two global `onRequest` hooks already run for every request: `makeAuthHook(opts.token)` (token auth) and one that stamps `req.xatsPeer = classifyPeerAddress(req.raw.socket.remoteAddress)` with `{ origin: 'local' | 'remote', remote_addr }`. So token auth and loopback classification are already available to any new route for free.

The MCP tools' behavior lives in reusable service classes:
- `SendMessageService` (`src/mcp/send-message.ts`) — resolves recipient, inserts the message + event, and fans out the poke via `runFanoutWithRetry`. Its `from` is just an `agent_id` string.
- `GetInboxService.get({ caller, since_event_id, limit })` (`src/mcp/get-inbox.ts`) — already implements the exact cursor contract we want: omit `since_event_id` → read + advance stored cursor; supply it → read-only.
- `list_agents` is currently inline in `src/mcp/tools.ts` (not a standalone service).

The identity/side-effect machinery (session map, `RegisterAgentService.connections`, fanout attach/detach) is owned by `mountMcp` and the MCP tool handlers; the service classes above touch only the DB and the poke transport, NOT that machinery.

## Goals / Non-Goals

**Goals:**
- A loopback-only `/api/send`, `/api/inbox`, `/api/agents` that an agent can drive with a single `curl` when its MCP client is dead.
- Behavior identical to the MCP tools by REUSING their service code, not reimplementing it.
- A hard invariant: zero session / connection / delivery side-effects, so the lifeboat is safe even while the agent's MCP session is alive.

**Non-Goals:**
- No `register_agent` (or any identity-binding) over REST — this is the takeover footgun the design exists to avoid.
- No remote access — loopback only.
- No new tools beyond send / inbox / agents in v1 (no broadcast, delivery-status, reconnect, etc.).
- No change to the `/mcp` wire contract or to `get_inbox` / `send_message` tool behavior.

## Decisions

### D1. Reuse the service layer; the REST handlers are thin adapters
The three handlers construct the same `SendMessageService` / `GetInboxService` / `list_agents` query the MCP path uses, passing a resolved `agent_id` as the caller. This guarantees parity and avoids a divergent second implementation. **Alternative considered:** reimplement the SQL in the REST module — rejected (drift, double maintenance).

### D2. Identity by `(team, name)` lookup against the persisted `agents` row — never via a session
`from` / inbox-owner is resolved with a `SELECT ... FROM agents WHERE team=? AND name=? AND device=<local>`. The row persists after the agent's MCP session closes (session teardown detaches bindings but does not delete the row), so a stranded agent is still resolvable. If no row → reject (`unknown_sender`). No `agent_id` is ever created here. **This is the mechanism that makes the no-side-effect invariant hold by construction:** there is simply no code path from REST into the session/register machinery.

### D3. Loopback gate + token reuse the existing hooks
A per-route (or `/api`-scoped) check on `req.xatsPeer.origin === 'local'` returns 403 for remote. Token auth needs NO new code — the global `makeAuthHook` already runs first. Order: token (401) then loopback (403); both must pass. **Note:** a remote caller with a correct token still gets 403 — the loopback gate is independent of auth.

### D4. Inbox cursor semantics come free from `GetInboxService`
Map the `since_event_id` query param straight through: absent → `get({ caller, since_event_id: undefined })` (advances), present → `get({ caller, since_event_id: N })` (read-only). No new cursor logic. Matches the user's decision "default = real read".

### D5. `list_agents` needs a small extraction
Because `list_agents` is inline in `tools.ts`, `/api/agents` needs either a tiny extracted helper (`listAgentsForTeam(db, team)`) that both the tool and the REST route call, or a direct equivalent query. Prefer extraction so the two stay in lockstep. The extraction MUST NOT change the tool's output.

### D6. Mounting: a `mountRestApi(app, db, deps)` called from `buildServer`
Symmetric to `mountMcp`. It receives the `db` and the SAME dispatch/poke deps (`fanout`, `channelWakeFanout`, tmux poke, codex-appserver, opencode-server) that `send_message` uses for fan-out, so `/api/send` pokes recipients identically. Mount it after the existing hooks so auth + origin classification are already applied.

### D7. Plain JSON error bodies are fine here
Unlike `/mcp` (where a bare `{error}` body poisons strict `rmcp` clients), `/api/*` consumers are `curl`/HTTP clients. A plain `{ "error": "unknown_sender" }` JSON body with the right status is the clearest contract. The MCP-poisoning constraint does not apply.

## Risks / Trade-offs

- **[Impersonation friction drops to zero]** Any loopback process (with the token, if set) can send as any local agent, no takeover, no signal. → Mitigation: loopback-only + token + no-register; documented as an accepted tradeoff consistent with the existing local-trust model. If a deployment needs it off, a future `--no-rest` flag could disable the surface (out of scope for v1; note only).
- **[`/api/send` must wire the exact fan-out deps]** If the REST module constructs `SendMessageService` with different/absent poke deps, delivery would silently differ from MCP. → Mitigation: share the same deps object `buildServer` already builds for `mountMcp`; add a parity test that a REST send pokes the recipient the same way.
- **[`list_agents` extraction could alter tool output]** → Mitigation: pure move of the query into a helper; keep an existing `list_agents` tool test green.
- **[Loopback classification correctness]** The gate leans entirely on `classifyPeerAddress`. IPv4-mapped IPv6 loopback etc. are already handled there (see `network-origin` tests). → Reuse, don't re-derive.
- **[Only the running daemon matters]** Like the prior fix, this is inert until the user's installed daemon is rebuilt/restarted.

## Open Questions

- Response shape parity: should `/api/send` mirror the tool's `content`-wrapped MCP result, or return the raw `{ message_id, event_id, recipients, poked, ... }` object? Leaning raw object (cleaner for curl); confirm during implementation.
- Do we want `GET /api/agents` to include the same `online` liveness flag the tool computes? Default yes (same helper), but it adds a process-liveness probe per call — acceptable.
