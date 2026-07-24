# Design: add-agent-row-removal-api

## Context

`AgentsRepo.deleteById` (`src/storage/agents-repo.ts`) already implements the delete. `UnregisterSelfService` (`src/mcp/unregister-self.ts`) is a 30-line wrapper around `findById` + `deleteById` in a transaction. The REST surface (`src/daemon/rest-api.ts`) is loopback-gated, bearer-authenticated, and documented as reusing the same service layer as the MCP tools. So the change is almost entirely about picking the right addressing and the right semantics — not about new machinery.

## D1: REST only, no MCP tool

An MCP `unregister_agent({agent_id})` would give every registered agent the ability to remove any teammate's row, including rows belonging to other devices. Removing a live agent's row makes its next tool call fail, so the tool would double as a remote disrupt primitive between peers that are supposed to *communicate*, not command each other.

The motivating case was an operator cleaning up after itself on the local machine. REST already models exactly that role: loopback-only, bearer-authenticated, sessionless, explicitly framed as a lifeboat/ops surface. Put the capability there and nowhere else.

## D2: Address by `agent_id`, not `(team, name)`

The other REST endpoints resolve identity as `(localDevice, team, name)`. Removal must not, for a concrete reason: one of the rows that motivated this change was `xats-kimi` carrying device label `jtianlings-macbook-pro-local` while the daemon's `localDevice` is `jt` — the same physical machine registered twice under different labels. A `(team, name)` lookup pinned to `localDevice` cannot reach that row, which is precisely the kind of orphan that most needs removing.

`agent_id` is device-agnostic and is already what `GET /api/agents` returns, so the natural operator flow is list → pick id → delete. `POST /api/send` already accepts `to.agent_id`, so id-based addressing is not new to this surface.

## D3: Unknown id is 404, not a silent success

A cleanup endpoint that cannot distinguish "removed it" from "there was nothing there" is a bad cleanup endpoint — the operator wants to know whether their id was stale. Return `404 { error: 'unknown_agent' }`, reusing the error string `UnregisterSelfService` already returns, rather than inventing a second vocabulary for the same condition.

## D4: Removal is registry-only and MUST be documented as such

This is the part most likely to be misused, so it is spec'd rather than left to intuition.

Removing a row does not stop anything. It deletes the daemon's knowledge of an agent; it does not touch the process, pane, or session behind it. The consequences differ per runtime and the kimi-code case is genuinely counter-intuitive:

- A kimi-code session keeps running and keeps accepting `POST /sessions/<id>/prompts`. Kimi sessions cannot be deleted through kimi's REST API at all (its whole surface has three `DELETE` routes and none of them is for sessions). So the session outlives the row indefinitely; only its addressability through xats is gone.
- A live agent of any runtime whose row is removed will fail its next xats tool call with `unknown_agent` and has to re-register. That is a real consequence of an operator action, not a bug — but the endpoint must not be sold as a graceful shutdown.

Historical messages and events keep referencing the removed `agent_id` as stored text, exactly as `unregister_self` already specifies. Removal does not rewrite history.

## D5: One removal code path

Extract the transactional `findById` + `deleteById` body from `UnregisterSelfService.unregister` into a helper exported from the same module, and have both the MCP tool and the REST handler call it. This keeps `rest-api.ts`'s stated invariant ("reuses the SAME service layer as the MCP tools") true rather than aspirational, and means a future change to removal semantics has one place to land.

`UnregisterSelfService`'s public behaviour and error vocabulary do not change.

## Rejected alternatives

- **Refuse to remove rows that look online.** Rejected: `online` is meaningless for kimi-code (no `runtime_ui_pid`, no `tmux_pane_id`, so `isAgentLive` falls through to a 4-day `last_seen_at` window and reads `true` for days after the fact). The gate would reliably block the rows that most need removing.
- **Bulk removal by team, or by staleness threshold.** Rejected as speculative: the motivating case was four specific rows, and a bulk delete keyed on a liveness signal that does not work for kimi would be actively dangerous. Single-id removal composes fine with `GET /api/agents`.
