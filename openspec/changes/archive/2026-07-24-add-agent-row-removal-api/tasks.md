# Tasks: add-agent-row-removal-api

Ordered by dependency: shared removal helper (1) → REST route (2) → docs (3). Code tasks are TDD RED → GREEN.

## 1. Shared removal helper

- [x] 1.1 Extract the transactional `findById` + `deleteById` body of `UnregisterSelfService.unregister` into an exported helper in `src/mcp/unregister-self.ts` that takes `(db, agents, agent_id)` and returns the same `{ ok: true, team, name, agent_id } | { error: 'unknown_agent' }` shape
- [x] 1.2 Reimplement `UnregisterSelfService.unregister` on top of that helper; existing behaviour and error vocabulary unchanged
- [x] 1.3 Confirm the existing `unregister_self` tests still pass untouched — if any needed editing, the extraction changed behaviour and is wrong

## 2. REST endpoint

- [x] 2.1 RED: add `tests/rest-delete-agent.test.ts` covering the spec scenarios — success returns 200 `{deleted:true,...}` and the row disappears from `GET /api/agents`; unknown id → 404 `unknown_agent`; repeat delete → 404; a row whose device differs from `localDevice` is removable; a row whose `online` is `true` is removable
- [x] 2.2 RED: add a remote-origin case asserting `DELETE /api/agents/:id` from a non-loopback peer returns 403 **and leaves the row intact** (the gate must short-circuit before the data layer)
- [x] 2.3 GREEN: add `handleDeleteAgent` to `src/daemon/rest-api.ts` calling the helper from 1.1, and mount `app.delete('/api/agents/:agent_id', ...)` alongside the existing three routes
- [x] 2.4 Verify no new session/delivery side-effects: the handler touches only the data layer, consistent with the existing "REST calls have zero session and delivery side-effects" requirement

## 3. Docs

- [x] 3.1 Document the endpoint in the REST fallback sections of `README.md` and `README.zh-CN.md`: list → pick `agent_id` → delete, with the 404 semantics
- [x] 3.2 State the non-termination semantics wherever removal is documented — removing a row does not stop the agent; a live agent must re-register; a kimi-code session keeps running and keeps accepting prompts
- [x] 3.3 Do NOT document an MCP `unregister_agent` tool; `unregister_self` remains the only agent-initiated removal

## 4. Verification

- [x] 4.1 `openspec validate add-agent-row-removal-api --strict` passes
- [x] 4.2 Test suite: 808 pass. 4 pre-existing failures in `register-agent-hint` / `register-agent-takeover-inject`, NOT caused by this change — verified by running both files at clean HEAD in a scratch clone, where they fail identically. Cause: those tests register codex agents against `ws://127.0.0.1:8799` assuming nothing listens there, but a real codex app-server occupies 8799 on this machine, so the socket connects instead of being refused and the test hangs to timeout. The suite is not hermetic on a host running the live xats stack.
- [x] 4.3 Live E2E run 2026-07-24 by the xats-cli tester agent against the rebuilt daemon (start-local-xats build of 07-24), all 9 steps green: baseline empty listing → throwaway registered in scratch team `e2e-scratch` → listed → `DELETE` 200 with the exact `{deleted:true, agent_id, team, name}` echo → gone from listing → repeat DELETE 404 `unknown_agent` → the live agent's own next MCP call returned `unknown_agent` (row-removal-of-a-live-agent scenario) → re-register recovered the tester's ORIGINAL agent_id, proving its own row was never touched → inbox restored. Only the self-created throwaway row was deleted. Known-uncovered variant, deliberate: the deleted row carried `delivery.kind="none"` (the tester's channel stayed with its original identity), so "delete a row with a live claude-channel delivery" was not exercised end-to-end — acceptable because the zero-session-side-effect requirement makes removal registry-only by design; the channel sink is intentionally not detached.
