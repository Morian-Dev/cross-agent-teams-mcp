## Why

When an agent's MCP client transport breaks (e.g. the codex `rmcp` poisoning fixed in `2026-07-01-fix-mcp-session-error-envelope`), the agent can no longer call any xats tool — it cannot even `send_message` to tell anyone it is stuck, nor `get_inbox` to read the body of a message it was poked about (pokes carry only a hint, not the body). The daemon exposes only `/mcp` (full JSON-RPC + session handshake + SSE) and `/health`, so the only fallback is to hand-drive the MCP protocol over `curl`. That path is both painful (4 round-trips + SSE parsing + session juggling) AND dangerous: to send, `curl` must `register_agent`, and a cross-session register triggers the `agent-registry` **takeover** — it force-closes and rebinds the agent's real session. So today the raw-`curl` lifeboat only works when the agent's session is already dead, and silently hijacks it when it is alive. The README (~line 264) accordingly tells users NOT to use `curl`.

We want an **officially supported lifeboat**: a tiny, loopback-only REST surface that lets an already-registered agent send, read its inbox, and list agents WITHOUT a working MCP client and WITHOUT any session side-effect.

## What Changes

- Add three loopback-only REST endpoints on the existing daemon port under an `/api/` prefix:
  - `POST /api/send` — send a message as an existing agent identified by `(from.team, from.name)`.
  - `GET /api/inbox` — read the inbox of an agent identified by `(team, name)`.
  - `GET /api/agents` — list agents in a team.
- Establish a hard **no-session-side-effect invariant**: a REST call NEVER mutates any in-memory MCP session, connection binding, or delivery binding. It acts purely at the data layer on behalf of an already-registered `agent_id`, reusing the SAME service code as the MCP tools (`SendMessageService`, `GetInboxService`, the `list_agents` query) so behavior is identical. Because there is no session side-effect, it is safe whether the target agent's MCP session is alive or dead — strictly safer than raw-`curl` register.
- Gate all `/api/*` routes to **loopback origin only**: non-loopback (remote) requests get HTTP 403. Remote agents get no REST API — a deliberate scope cut (name-based impersonation over the network is too costly). Token auth applies exactly as for `/mcp` via the existing global auth hook.
- REST is a **send/read lifeboat only**: it deliberately does NOT expose `register_agent` (that is the takeover footgun this design avoids by construction), nor any other tool. v1 is exactly send + inbox + agents.
- Update the README "don't use curl" note to point at the supported `/api/*` lifeboat (raw MCP-over-curl remains discouraged because of takeover).

## Capabilities

### New Capabilities
- `rest-fallback-api`: a loopback-only, sessionless REST surface (`POST /api/send`, `GET /api/inbox`, `GET /api/agents`) that lets an already-registered agent send / read inbox / list agents without an MCP session, reusing the MCP tools' service layer and guaranteeing zero session/delivery side-effects.

### Modified Capabilities
<!-- none — additive. Token auth already blankets all daemon HTTP requests via the existing onRequest hook; the new capability documents that /api inherits it. -->

## Impact

- Code: `src/daemon/server.ts` (mount the new routes alongside `mountMcp`), a new REST module (e.g. `src/daemon/rest-api.ts`) holding the three handlers, reusing `SendMessageService` (`src/mcp/send-message.ts`), `GetInboxService` (`src/mcp/get-inbox.ts`), and the `list_agents` query (currently inline in `src/mcp/tools.ts` — may need a small extracted helper).
- Reuses the existing `req.xatsPeer.origin` classification (`src/daemon/network-origin.ts`) for the loopback gate and the existing `makeAuthHook` for token auth — no new auth machinery.
- Docs: `README.md` / `README.zh-CN.md` curl guidance.
- No DB schema change. No change to the MCP wire contract.
