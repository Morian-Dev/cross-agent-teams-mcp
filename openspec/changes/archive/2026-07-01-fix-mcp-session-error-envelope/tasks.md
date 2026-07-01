## 1. Pin the non-poisoning body contract (do first — gates everything)

- [x] 1.1 Write a helper in `src/mcp/transport.ts` (or a small shared module) that emits a control-plane rejection: given a Fastify `reply`, an HTTP status, and an optional machine-readable message, it sends the agreed non-poisoning body (empty body, or a JSON-RPC 2.0 error envelope `{"jsonrpc":"2.0","id":null,"error":{"code","message"}}`).
- [ ] 1.2 Verify the chosen body shape against a strict `rmcp` client (real codex session, or a focused reproduction) — confirm it does NOT raise `did not match any variant of untagged enum JsonRpcMessage`. If the JSON-RPC envelope with `id:null` is rejected, fall back to empty body. Record the verified choice in design.md's Open Questions.

## 2. Unknown/expired session → 404 (mcp-transport)

- [x] 2.1 POST `/mcp` unknown-session branch: change `reply.code(400).send({ error: 'unknown_session' })` to status **404** via the 1.1 helper.
- [x] 2.2 GET `/mcp` unknown-session branch: same change to 404 + helper.
- [x] 2.3 DELETE `/mcp` unknown-session branch: same change to 404 + helper.
- [x] 2.4 Confirm the existing `log('mcp unknown_session: ...')` lines are preserved and that a failed session lookup still does NOT bump any session timestamp.

## 3. Sibling control-plane rejections keep status, lose bare `{error}` body

- [x] 3.1 `agent_id_collision` (409) branch in `src/mcp/transport.ts`: keep 409, emit body via the 1.1 helper.
- [x] 3.2 `identity_mismatch` (403) branch in `src/mcp/transport.ts`: keep 403, emit body via the 1.1 helper.
- [x] 3.3 `invalid_token` (401) in `src/daemon/auth.ts`: keep 401, emit body via the 1.1 helper (or an equivalent local helper); keep any `WWW-Authenticate` behavior unchanged.

## 4. Orphan GC: activity exempts from max-age (mcp-transport)

- [x] 4.1 In `reapOrphanSessions` (`src/mcp/transport.ts`), change the max-age reap so an orphan whose `lastActivityAt` is within `idleMs` is NOT reaped by max-age. Idle reap (condition 1) and the orphan cap (condition 3) are unchanged.
- [x] 4.2 Keep all `ORPHAN_GC_*` / `orphanGc*` config knobs and defaults untouched (only the max-age-vs-activity rule changes).

## 5. Audit internal consumers of the old wire contract

- [x] 5.1 Confirm the bundled channel proxy is unaffected: `plugins/cross-agent-teams-channel/src/daemon-client.ts` goes through the official SDK client (status-routed), not the raw `{error}` body. Exercise a proxy register/reconnect against the new 404 and confirm no rapid respawn loop.
- [x] 5.2 Grep for any other reader that string-matches `unknown_session` / `invalid_token` / `agent_id_collision` / `identity_mismatch` on an HTTP response body (vs a tool-result payload) and update or confirm safe.

## 6. Tests

- [x] 6.1 Update existing tests that assert `400` + `{"error":"unknown_session"}` (POST/GET/DELETE) to expect `404` + a non-`{error}` body.
- [x] 6.2 Update token/collision/identity tests to expect the new body shape (status codes unchanged: 401/409/403).
- [x] 6.3 Add a regression test: an unknown `Mcp-Session-Id` response body MUST NOT be a bare `{"error":...}` object (assert it is empty or a valid JSON-RPC 2.0 error object).
- [x] 6.4 Add/adjust orphan-GC tests: an active orphan past max-age is NOT reaped (was previously reaped); an idle orphan past max-age still IS reaped; the cap still reaps active orphans when over `maxSessions`.
- [ ] 6.5 End-to-end: drive a real codex session through `compact` and a stale-session request; confirm no `Deserialize error` / `Transport send error`, and that the client re-initializes and continues.

## 7. Build + spec validation

- [x] 7.1 `pnpm build` clean.
- [x] 7.2 `openspec validate fix-mcp-session-error-envelope --strict` passes.
- [x] 7.3 Note in the change/rollout that the fix is inert until the user's running npx `cross-agent-teams-mcp` daemon is updated and restarted.
