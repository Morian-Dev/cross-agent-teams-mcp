## Why

The daemon's `/mcp` Streamable HTTP endpoint answers session-control failures (unknown/expired session, auth failure, identity collision) with a bare JSON body like `{"error":"unknown_session"}` and a 4xx status. Strict MCP clients — notably codex's `rmcp` client — feed the raw response body straight into a `JsonRpcMessage` deserializer. That bare object matches none of the JSON-RPC variants, so `rmcp` errors out (`Deserialize error: data did not match any variant of untagged enum JsonRpcMessage`), which poisons the whole transport worker: every subsequent tool call then fails with `Transport send error`, not just the offending one.

This was reproduced live against daemon v0.7.2 (`curl` an unknown `Mcp-Session-Id` → `HTTP 400 {"error":"unknown_session"}`). It is routinely triggered when a codex agent compacts: codex rebuilds its MCP session (a fresh, not-yet-registered "orphan" session), the daemon's orphan GC reaps it at `maxAge = 300_000 ms` (which ignores activity), and the next `register_agent` reuses the now-dead session id → `unknown_session` → transport poisoned.

## What Changes

- Unknown/expired MCP session on `POST` / `GET` / `DELETE /mcp` responds with **HTTP 404** and a body that is NOT a bare `{"error":...}` object. This GUARANTEES the rejection no longer poisons a strict client's transport (the empty body has nothing to mis-parse), and gives the client the standard MCP Streamable HTTP signal to start a new session (the spec requires clients to re-send `initialize` without a session id on 404). Whether a specific client — e.g. codex's `rmcp` — transparently re-inits and retries the in-flight call is client-dependent and verified separately (deferred live E2E). **BREAKING** (wire contract): status changes `400 → 404` and the `{"error":"unknown_session"}` body shape is removed.
- The remaining transport-layer early returns — `agent_id_collision` (409), `identity_mismatch` (403), and auth `invalid_token` (401) — stop emitting bare `{"error":...}` bodies. They return a body that strict clients will not mis-parse as a JSON-RPC message (empty body, or a proper JSON-RPC error envelope), while keeping the same HTTP status semantics.
- Orphan session GC becomes **idle-based + cap-based**: max-age is dropped as an independent reap trigger (once active sessions are exempt from age-based reaping, max-age only ever fires on sessions the idle rule already reaps). Idle-based and orphan-cap reaping are unchanged; the `ORPHAN_GC_MAX_AGE_MS` / `orphanGcMaxAgeMs` knob is retained but inert (no breaking config change). This removes the deterministic 5-minute kill of a live-but-unregistered primary session (e.g. a codex session mid-setup), shrinking the recurrence window.

Out of scope (tracked, not fixed here): the non-standard server→client notifications `notifications/heartbeat` and `notifications/channel_wake` can poison a strict client the same way if delivered over a long-lived GET stream. Called out in design as a follow-up; not changed in this change to keep the blast radius minimal.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `mcp-transport`: "Session id assignment" changes the unknown-session response from `400 {"error":"unknown_session"}` to a spec-compliant **404** with a non-poisoning body; "Orphan session garbage collection" is amended so reaping is idle-based + cap-based (max-age dropped as an independent trigger; knob retained but inert).
- `daemon-core`: "Optional bearer token authentication" keeps HTTP 401 but its body stops being a bare `{"error":"invalid_token"}` object.
- `agent-registry`: "Within-session agent_id_collision via Authorization header" (409) and "Mismatched agent_id for tool call returns 403" (403) keep their status codes but their bodies stop being bare `{"error":...}` objects.

## Impact

- Code: `src/mcp/transport.ts` (POST/GET/DELETE unknown-session returns, `agent_id_collision`, `identity_mismatch`, `reapOrphanSessions`), `src/daemon/auth.ts` (`invalid_token`).
- Wire contract: clients / tests that assert `400` + `{"error":"unknown_session"}` must be updated. The bundled `cross-agent-teams-channel` proxy is unaffected — it talks through the official `@modelcontextprotocol/sdk` client, which routes on HTTP status and does not read the raw error body (verified in `plugins/cross-agent-teams-channel/src/daemon-client.ts`).
- Tests: `tests/**` cases asserting the old unknown-session status/body, plus orphan-GC max-age-of-active-session behavior.
