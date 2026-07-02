## 1. Mount + gate scaffold

- [x] 1.1 Add `mountRestApi(app, db, deps)` (e.g. `src/daemon/rest-api.ts`) and call it from `buildServer` (`src/daemon/server.ts`) after the existing `onRequest` hooks and alongside `mountMcp`. It receives `db` and the SAME dispatch/poke deps object used for `mountMcp` (`fanout`, `channelWakeFanout`, tmux poke, codex-appserver, opencode-server).
- [x] 1.2 Add a loopback gate applied to every `/api/*` route: reject with HTTP 403 (plain JSON body) when `req.xatsPeer?.origin !== 'local'`. Confirm token auth is already enforced by the existing global `makeAuthHook` (no new auth code).

## 2. POST /api/send

- [x] 2.1 Resolve `from` by `(from.team, from.name)` against the local-device `agents` row → `agent_id`; reject `unknown_sender` (no insert) when absent.
- [x] 2.2 Reuse `SendMessageService` with the resolved `from` agent_id to resolve the recipient (`to.{team,name}` or `to.agent_id`), insert message + event, and fan out the poke — honoring `subject?`, `need_reply?` (default true), `auto_poke?` (default true) exactly like the tool.
- [x] 2.3 Return the send result as a plain JSON object (message_id, event_id, recipients, poke outcome), matching the tool's data. `unknown_recipient` maps through unchanged.

## 3. GET /api/inbox

- [x] 3.1 Resolve owner by `(team, name)` → agent_id; reject when absent.
- [x] 3.2 Call `GetInboxService.get({ caller, since_event_id })`: pass `since_event_id` through when present (read-only), omit it when absent (advance cursor). Return `{ messages, has_more, last_event_id }` as JSON.

## 4. GET /api/agents

- [x] 4.1 Extract the inline `list_agents` query from `src/mcp/tools.ts` into a shared helper (e.g. `listAgentsForTeam(db, team)`) WITHOUT changing the tool's output; have the tool call the helper.
- [x] 4.2 Implement `GET /api/agents?team=` to return the helper's result (team-scoped) as JSON.

## 5. Tests — behavior parity

- [x] 5.1 `/api/send`: loopback send by (team,name) inserts the same message row and pokes the recipient the same way as the `send_message` tool; response shape asserted.
- [x] 5.2 `/api/send`: `unknown_sender` (no such registered from) → rejected, no insert; `unknown_recipient` → same outcome as the tool; `auto_poke:false` → inserted, not poked.
- [x] 5.3 `/api/inbox`: default read advances `last_processed_event_id`; explicit `since_event_id` is read-only (cursor unchanged); unknown owner rejected.
- [x] 5.4 `/api/agents`: returns only the requested team's agents (no cross-team leak).

## 6. Tests — the no-side-effect invariant (key)

- [x] 6.1 With agent `alice` holding a LIVE MCP session + delivery binding, a `POST /api/send` as `alice` leaves her session present in the `sessions` map and her delivery binding intact (assert NO takeover / force-close).
- [x] 6.2 A REST call creates NO new MCP session and NO `RegisterAgentService.connections` entry, and attaches/detaches NO fanout/channel-wake sink.

## 7. Tests — gate + auth

- [x] 7.1 Remote origin → 403 on every `/api/*` route, with no data-layer action (reuse the network-origin test harness pattern; simulate a non-loopback peer).
- [x] 7.2 With `--token` set: missing/mismatched token → 401; correct token + loopback → served; correct token + remote → still 403.

## 8. Docs

- [x] 8.1 Update `README.md` (~line 264) and `README.zh-CN.md`: keep discouraging raw MCP-over-curl (takeover), and document the supported `/api/*` loopback lifeboat with a copy-paste `curl` example for send / inbox / agents.

## 9. Build + spec validation

- [x] 9.1 `pnpm build` clean.
- [x] 9.2 Full test suite green (`pnpm test`).
- [x] 9.3 `openspec validate add-rest-fallback-api --strict` passes.
