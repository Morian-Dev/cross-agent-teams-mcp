# Tasks: add-kimi-code-poke

## 1. DeliverySpec + AgentType unions

- [x] 1.1 Extend `src/lib/delivery-spec.ts`: add `DeliveryKimiServer` (`{ kind: 'kimi-server', session_id, base_url, auth_token_ref? }`) to the union, `DELIVERY_KINDS`, `parseDeliveryRow` (read validation: non-empty session_id/base_url, optional non-empty auth_token_ref), and `validateDeliveryForWrite` (trimmed non-empty session_id with no prefix constraint, http/https base_url, non-empty auth_token_ref when present; reasons reuse `invalid_session_id`/`invalid_base_url`/`invalid_auth_token_ref`)
- [x] 1.2 Extend `src/lib/agent-type.ts`: add `'kimi-code'` to `AgentType`
- [x] 1.3 Extend `tests/delivery-spec.test.ts` with kimi-server cases mirroring the opencode-server cases (parse/serialize/validate accept + reject paths)

## 2. kimi-server poke dispatcher

- [x] 2.1 Create `src/mcp/kimi-server-dispatch.ts` (mirror `opencode-server-dispatch.ts`): POST `<base_url>/api/v1/sessions/<session_id>/prompts` with body `{ content: [{ type: 'text', text: content }] }` and `Authorization: Bearer <token>`; 2xx → `{ ok: true, transport_used: 'kimi-server', session_id }`; fetch rejection → `kimi_connect_failed`; non-2xx → `kimi_inject_failed { status, body≤4KB }`
- [x] 2.2 Token resolution: `auth_token_ref` present → env var lookup (missing/empty → `missing_auth_token` before any I/O); absent → read `~/.kimi-code/server.token` (missing/empty → `missing_auth_token`); token file path injectable via deps for tests
- [x] 2.3 Wire into `src/mcp/transport-dispatch.ts`: add `dispatchKimi` branch (agent_type `kimi-code` or delivery.kind `kimi-server`), no tmux fallback on dispatcher failure, extend `DispatchResult` with the `kimi-server` variants
- [x] 2.4 Create `tests/kimi-server-dispatch.test.ts` mirroring `tests/opencode-server-dispatch.test.ts` (success body/headers, env-ref token, token-file fallback, missing_auth_token both paths, connect_failed, inject_failed, no tmux fallback)

## 3. register_agent kimi-code branch

- [x] 3.1 Extend the register tool schema in `src/mcp/tools.ts`: accept `agent_type='kimi-code'`; Zod refinement requiring `base_url` (http/https) and REQUIRED `session_id` for kimi-code, with error messages referencing `KIMI_XATS_BASE_URL` / `session_index.jsonl`
- [x] 3.2 Add the kimi-code branch in register execution (mirror the opencode branch): write `delivery={kind:'kimi-server', session_id, base_url, auth_token_ref?}`, response `{ agent_id, team, session_id, base_url }`, `model` defaults to NULL, NO registration-time health check
- [x] 3.3 Update the `register_agent` tool description DETECTION block in `src/mcp/tools.ts`: add `KIMI_XATS_BASE_URL` probe as first check, with `session_index.jsonl`-derived explicit `session_id` instructions; update top-level server instructions to mention `KIMI_XATS_BASE_URL`
- [x] 3.4 Add tests mirroring the opencode register tests (delivery written, schema rejections for missing session_id/base_url/ws-scheme, auth_token_ref preserved, model NULL default, description contains `KIMI_XATS_BASE_URL` + `session_index.jsonl`)

## 4. Docs

- [x] 4.1 README (and README.zh-CN.md / README.agent.md if they carry the launcher sections): document the `kimi-server` delivery kind, the `xats-kimi` zsh function, and the `start-xats`/`stop-xats` kimi-server blocks, mirroring the opencode launcher docs

## 5. ~/.zshrc application (out-of-repo, explicitly requested by user)

- [x] 5.1 Add `xats-kimi` function to `~/.zshrc`: resolve base_url (`${KIMI_XATS_BASE_URL:-http://127.0.0.1:58627}`), start `kimi server run --keep-alive` if port not listening and wait for it, then `KIMI_XATS_BASE_URL=... exec kimi --yolo "$@"`
- [x] 5.2 Extend `start-xats` in `~/.zshrc`: start kimi server via `kimi server run --keep-alive` when `kimi` binary exists and port is free, with `_xats-log-event` logging; skip silently otherwise
- [x] 5.3 Extend `stop-xats` in `~/.zshrc`: `kimi server kill` with lsof/kill fallback on port 58627
- [x] 5.4 Manual smoke: `start-xats` brings up kimi server; a kimi-code agent registers and a DM poke reaches a TUI-open kimi session via the kimi-server transport (validates the TUI/server concurrency assumption in design.md)

## 6. Exact session_id via launcher pre-creation (2026-07-20, after live-test failure of the session_index heuristic)

- [x] 6.1 Verify `POST /api/v1/sessions` + init prompt + `kimi --session <id>` attach works end-to-end on kimi 0.27.0 (verified live: create → init prompt materializes `agents/main` → CLI attaches and runs)
- [x] 6.2 Rewrite `xats-kimi` in `~/.zshrc`: pre-create session via REST (token from `~/.kimi-code/server.token`), fire init prompt, wait for `agents/main`, export `KIMI_XATS_SESSION_ID` + `KIMI_XATS_BASE_URL`, `exec kimi --session <id> --yolo "$@"`; abort without launching when pre-creation fails
- [x] 6.3 Update `register_agent` DETECTION block + kimi branch text (`src/mcp/tools.ts`) and server instructions (`src/mcp/transport.ts`): `session_id` now comes from `$KIMI_XATS_SESSION_ID`; session_index.jsonl derivation explicitly warned against
- [x] 6.4 Update `tests/register-agent-kimi-code.test.ts` description assertions to `KIMI_XATS_SESSION_ID`
- [x] 6.5 Sync spec deltas (`kimi-server-transport`, `agent-registry`) and design D4/D5 to the pre-creation mechanism
- [x] 6.6 Fix server-created sessions carrying no model: live test showed init prompt + all pokes fail instantly with `model.not_configured` (delivered but never wakes); launcher now sets `agent_config.model` via `POST /api/v1/sessions/<id>/profile` (from `default_model` in `~/.kimi-code/config.toml`) right after creation; verified `prompt.completed reason=completed` for both init turn and a real xats poke on the live tester session
- [x] 6.7 Fix poke-woken turns blocking on tool approvals: server-driven turns use the session's permission mode (default `manual`), not the CLI `--yolo` flag — a woken agent's first tool call (`get_inbox`) blocked on an unanswered approval; launcher profile POST now also sets `permission_mode: "yolo"`; verified the blocked turn completed after approval + new turns run tool calls freely
