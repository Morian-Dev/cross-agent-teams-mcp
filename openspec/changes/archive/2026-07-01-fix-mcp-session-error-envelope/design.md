## Context

The daemon exposes MCP over Streamable HTTP via `@modelcontextprotocol/sdk`'s `StreamableHTTPServerTransport`, but `src/mcp/transport.ts` owns session routing itself (a `sessions` Map keyed by `Mcp-Session-Id`). For control-plane failures it short-circuits with hand-rolled Fastify replies that bypass the SDK:

- POST/GET/DELETE unknown session → `reply.code(400).send({ error: 'unknown_session' })` (`transport.ts` ~272-275 / ~330-333 / ~341-345)
- `register_agent` Authorization mismatch → `reply.code(409).send({ error: 'agent_id_collision' })` (~280-289)
- tool call with spoofed `from_agent_id` → `reply.code(403).send({ error: 'identity_mismatch' })` (~293-301)
- token guard (`src/daemon/auth.ts` ~15) → `reply.code(401).send({ error: 'invalid_token' })`

Each of these bodies is a bare `{ "error": <string> }` object. codex's built-in `rmcp` client (`codex_rmcp_client::http_client_adapter::StreamableHttpClientAdapter`) deserializes ANY response body it reads into an untagged `JsonRpcMessage` enum. A bare `{error}` object matches none of the JSON-RPC 2.0 variants, so `rmcp` raises `Deserialize error: data did not match any variant of untagged enum JsonRpcMessage`. That kills the transport worker; every later `send` then fails with `Transport send error`. Reproduced live against daemon v0.7.2 with `curl` (unknown `Mcp-Session-Id` → `HTTP 400 {"error":"unknown_session"}`).

Trigger in the field: a codex agent `compact`s, its `rmcp` transport rebuilds a fresh (not-yet-registered) MCP session, the orphan GC reaps it at `maxAge = 300_000 ms` regardless of activity, and the next `register_agent` reuses the now-dead `Mcp-Session-Id` → `unknown_session` → poison. Measured "process start → first standard-MCP tool failure" ≈ 342 s, inside the `[300, 360]` window (300 s max-age + up to 60 s GC tick). Two agents reached this conclusion independently; `curl` reproduction confirms the wire behavior.

## Goals / Non-Goals

**Goals:**
- No `/mcp` control-plane response body can be mis-deserialized as a JSON-RPC message by a strict client. Fix the whole class (unknown_session, invalid_token, agent_id_collision, identity_mismatch), not just the one that fired.
- Unknown/expired session returns HTTP **404** — the standard signal for a spec-conformant client to re-initialize (per the MCP Streamable HTTP transport spec). This change GUARANTEES the rejection no longer poisons a strict client's transport; whether a given client transparently re-inits and retries the in-flight call is client-behavior verified separately (deferred E2E).
- Reduce recurrence: an actively-transacting but not-yet-registered session is not deterministically killed at 5 minutes.
- Preserve existing behavior for the bundled `cross-agent-teams-channel` proxy and for tests that legitimately need machine-readable errors.

**Non-Goals:**
- Replacing the non-standard server→client notifications `notifications/heartbeat` (`transport.ts` ~143-152) and `notifications/channel_wake` (`channel-wake-send.ts`). These can poison a strict client the same way over a long-lived GET stream, but were not this incident's trigger; tracked as a separate follow-up to keep the blast radius small.
- Changing the SDK's own JSON-RPC-level error responses (those already come from the SDK and are well-formed).
- Reworking the orphan-GC config surface (`ORPHAN_GC_*` knobs stay; only the max-age-vs-activity rule changes).

## Decisions

### D1. Unknown/expired session → HTTP 404 (status change), not 400
The MCP Streamable HTTP spec says a client receiving `404` for a request carrying a session id MUST start a new session by re-sending `initialize` without a session id. `400` gives the client no standard recovery signal. Switching to `404` gives spec-conformant clients the standard signal to re-initialize.

**What is proven vs. not proven (do NOT overstate):**
- **Proven here:** the rejection no longer poisons a strict client's transport worker — the empty body has nothing to mis-deserialize (covered by the empty-body helper + strict-client regression test).
- **NOT proven here:** whether codex's `rmcp` transparently re-`initialize`s AND retries the in-flight tool call on a `404`. The bundled JS SDK client (`@modelcontextprotocol/sdk` `StreamableHTTPClientTransport.send`, `streamableHttp.js:312-364`) throws `StreamableHTTPError` on a non-2xx POST with NO 404-reinit/retry branch; `rmcp` may implement spec recovery but this diff/tests do not demonstrate it. So "the client self-heals transparently" is a client-dependent behavior deferred to the live E2E (task 6.5), not a guarantee of this change.

**Alternative considered:** keep `400`, only fix the body. Rejected — `400` is semantically wrong here and gives the client no standard recovery signal, whereas `404` at least conveys "session gone, start a new one".

### D2. Non-poisoning body = empty body (default) OR a valid JSON-RPC 2.0 error envelope
Two safe shapes exist: (a) send NO body, or (b) send a well-formed JSON-RPC error `{"jsonrpc":"2.0","id":null,"error":{"code":C,"message":M}}`. Empty body is the simplest guaranteed-safe option: with no body there is nothing for `rmcp` to mis-parse. The JSON-RPC envelope keeps a machine-readable reason but depends on `rmcp` accepting `id: null` on its `JsonRpcError` variant — which MUST be verified before relying on it. **Decision:** the spec permits either; implementation SHOULD prefer the JSON-RPC envelope IF a strict-client test confirms it deserializes cleanly, otherwise fall back to an empty body. Status codes remain the source of truth for the failure kind (404 / 401 / 409 / 403), with an optional machine-readable `message` in the envelope for observability. **Alternative considered:** a custom header like `X-Xats-Error: unknown_session` alongside an empty body — deferred; only add if a consumer needs it.

### D3. Fix all four short-circuits, keep status codes stable except unknown_session
`invalid_token` (401), `agent_id_collision` (409), `identity_mismatch` (403) keep their HTTP status — only the body shape changes. They are the same defect class as unknown_session and each independently poisons a strict client if hit (e.g. a wrong token poisons on the very first `initialize`). Fixing one and leaving three is a knowing half-fix. **Alternative considered:** unknown_session only (the confirmed trigger). Rejected for correctness, but the deltas are structured so the three sibling fixes are trivially separable if scope must shrink.

### D4. Orphan GC becomes idle-based + cap-based; max-age is dropped as a trigger (knob kept inert)
`lastActivityAt` is bumped only by client POST/GET/DELETE, not by server→client heartbeats. So "has recent client activity" cleanly distinguishes a live, mid-setup client (codex just after compact) from a zombie that merely holds a stream open. We exempt active orphans from age-based reaping — but once active sessions are exempt, `maxAgeMs` has nothing left to catch that the idle rule does not already catch (its only trigger, age past `maxAgeMs` AND idle past `idleMs`, is a strict subset of the idle rule). So max-age is dropped as an independent reap trigger: **GC = idle-based reap + orphan cap.** The `maxAgeMs` / `ORPHAN_GC_MAX_AGE_MS` / `orphanGcMaxAgeMs` knob is retained (accepted, does not error) but INERT, to avoid a breaking config change. The orphan **cap** still evicts active orphans when over `maxSessions`, so total-orphan bounding is preserved — this keeps the anti-leak guarantee from the prior `fix-daemon-session-leak` work.

**Alternatives considered:** (i) raise `ORPHAN_GC_MAX_AGE_MS` default — a blunt knob that still eventually kills a legitimately long-lived pre-register session; (ii) keep max-age as a live-but-subset condition — leaves a provably-dead branch that misleads future readers (flagged in review). Dropping it and documenting the knob as inert is the honest encoding. Note: because D1+D2 already make a reap harmless (the client is not poisoned and can start a new session), D4 is a UX/recurrence improvement, not a correctness requirement — it can be dropped without reopening the poisoning bug.

## Risks / Trade-offs

- **[Wire-contract change breaks internal consumers/tests that read `{"error":...}`]** → Audit every reader. The bundled channel proxy uses the official `@modelcontextprotocol/sdk` client (`plugins/cross-agent-teams-channel/src/daemon-client.ts` — `terminateSession()` / `client.close()`), which routes on HTTP status and does not parse the raw error body, so it is unaffected and actually benefits from 404 (clean session-expiry signal). Update `tests/**` that assert `400` + `{"error":"unknown_session"}` and the token/collision/identity body asserts.
- **[`rmcp` rejects `id: null` in a JSON-RPC error envelope, re-introducing the poison]** → Gate D2's envelope form behind an explicit strict-client verification; ship empty-body if unverified. This is the single most important thing to prove during testing.
- **[404 changes SDK client behavior for the channel proxy]** → The SDK treats 404-with-session-id as terminated session and re-initializes; the proxy already has a register/subscribe retry loop, so this is within its existing recovery path. Verify no rapid respawn loop.
- **[D4 lets a misbehaving client keep an unregistered session alive indefinitely]** → Bounded by the orphan cap (`maxSessions`, default 500) which ignores activity; genuinely idle sessions still reaped by `idleMs`.
- **[Only the daemon binary the user actually runs matters]** → the live daemon is the npx-installed `cross-agent-teams-mcp@0.7.2`; this fix only takes effect once that install is rebuilt/republished and the daemon restarted. Call this out at rollout.

## Migration Plan

1. Land code + spec + tests on `main`; `pnpm build`.
2. Reproduce-then-verify: `curl` an unknown `Mcp-Session-Id` → expect `404` and a non-`{error}` body; then drive a real codex session through a compact and confirm no `Deserialize error`.
3. Rollout requires the user's running daemon (npx `cross-agent-teams-mcp`) to be updated and restarted — the fix is inert until then. No DB migration.
4. Rollback: revert the change; wire contract returns to `400 {"error":...}`. No persistent state involved.

## Open Questions

- Does codex's `rmcp` transparently re-`initialize` AND retry the in-flight tool call on a `404`, or does it re-init but surface the current call as failed? If the latter, D4 (or a larger max-age) matters more for UX. Confirm during testing with a real codex session.
- Preferred non-poisoning body shape (empty vs JSON-RPC envelope) — resolve via the D2 strict-client verification before implementation is finalized. **Implementation choice:** EMPTY body for all four rejections (404/401/409/403), emitted via the shared `sendControlPlaneReject` helper (`src/mcp/control-plane-reject.ts`) which calls `reply.code(status).send()` (verified in Fastify 5 to emit `Content-Length: 0`, no default `{}`). The JSON-RPC-envelope form was NOT adopted because it depends on `rmcp` accepting `id: null`, which could not be verified in this pipeline (no live codex/rmcp). Live rmcp verification (task 1.2) and the codex-compact E2E (task 6.5) remain deferred.
