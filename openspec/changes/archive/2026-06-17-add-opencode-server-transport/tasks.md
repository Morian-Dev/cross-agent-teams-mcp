## 1. DeliverySpec extension (agent-delivery)

- [x] 1.1 Add `DeliveryOpencodeServer` type (`{ kind: 'opencode-server'; session_id: string; base_url: string; auth_token_ref?: string }`) and add `'opencode-server'` to the `DeliverySpec` union + `DELIVERY_KINDS` array in `src/lib/delivery-spec.ts`
- [x] 1.2 Extend `parseDeliveryRow` to handle `kind === 'opencode-server'`: validate `session_id` is a non-empty string starting with `ses`, `base_url` is a non-empty string, and (when present) `auth_token_ref` is non-empty; raise `corrupt_delivery_payload` otherwise
- [x] 1.3 Extend `validateDeliveryForWrite` to accept `kind === 'opencode-server'` with `reason` values `invalid_session_id` (not `^ses` or empty) and `invalid_base_url` (not parseable URL or protocol not `http:`/`https:`); reuse `invalid_auth_token_ref` for blank `auth_token_ref`
- [x] 1.4 Extend `DeliveryValidationReason` union with `'invalid_session_id'` and `'invalid_base_url'`
- [x] 1.5 Update unit tests in `tests/delivery-spec.test.ts` (or sibling file) to cover parse round-trip + write-validator accept/reject for `'opencode-server'`

## 2. opencode-server dispatcher (new file)

- [x] 2.1 Create `src/mcp/opencode-server-dispatch.ts` exporting `dispatchOpencodeServerPoke({ delivery, content }, deps?)` and `OpencodeServerDispatchResult` type
- [x] 2.2 Implement auth-token resolution: read `process.env[auth_token_ref]`, return `{ error: 'missing_auth_token', detail: { ref } }` if unset/blank, otherwise attach `Authorization: Bearer <value>` header (no header when `auth_token_ref` absent)
- [x] 2.3 Implement the POST: `fetch(<base_url>/session/<session_id>/prompt_async, { method:'POST', headers:{'Content-Type':'application/json', ...authHeader}, body: JSON.stringify({ parts:[{type:'text', text:content}], noReply:true }) })`
- [x] 2.4 Implement result mapping: HTTP 2xx → `{ ok:true, transport_used:'opencode-server', session_id }`; fetch-reject / network error → `{ error:'opencode_connect_failed', detail, transport_used:'opencode-server' }`; non-2xx → `{ error:'opencode_inject_failed', detail:{ status, body: <string, truncated 4KB> }, transport_used:'opencode-server' }`
- [x] 2.5 Inject `deps.fetch` for testability (default to global `fetch`); inject `deps.env` (default to `process.env`)
- [x] 2.6 Unit-test dispatcher with mocked fetch: success 204, auth attached, auth omitted, missing auth token rejects pre-network, connection refused, 404 inject_failed, 500 inject_failed, no tmux fallback

## 3. Transport-dispatch routing

- [x] 3.1 In `src/mcp/transport-dispatch.ts`, add `'opencode-server'` branch that calls `dispatchOpencodeServerPoke` with `delivery = Extract<DeliverySpec, {kind:'opencode-server'}>`; no tmux fallback on failure
- [x] 3.2 Update `resolveClient`/`transport_used` enum types to include `'opencode-server'`
- [x] 3.3 Update existing poke/broadcast tests that enumerate transport kinds to include `'opencode-server'` where appropriate (negative cases: confirm opencode-server failures do not fall back to tmux)

## 4. register_agent extension

- [x] 4.1 Extend `registerAgentArgsSchema` (zod) to accept `base_url?: string` and `session_id?: string`, both with regex/format refinement; add a `.superRefine` that requires `base_url` to be a parseable `http://`/`https://` URL when `agent_type === 'opencode'`, and requires `session_id` to match `^ses` if supplied
- [x] 4.2 Add `'opencode'` to the `agent_type` zod enum (was: `'claude-code' | 'codex' | 'custom'`)
- [x] 4.3 Add `'opencode'` branch to `executeRegister` in `src/mcp/register-agent.ts`:
  - GET `<base_url>/global/health` first → on failure return `{ error:'opencode_unreachable', detail:{ base_url, cause } }` before writing any row
  - if `session_id` omitted: GET `<base_url>/session`, select max `time_updated`; on empty list return `{ error:'no_active_session', detail:{ base_url } }`
  - write `delivery = { kind:'opencode-server', session_id, base_url, auth_token_ref? }` via the existing delivery-write path; do NOT write `tmux_pane_id`, do NOT run channel auto-bind
  - return envelope `{ agent_id, team, session_id, base_url }`
- [x] 4.4 Make `model` optional for `agent_type='opencode'` (defaults to NULL — matches existing "truly optional" requirement, no new logic needed; verify via test)
- [x] 4.5 Inject a fetch+env dependency seam into `executeRegister` (or `RegisterAgentService`) so the opencode branch is unit-testable without real network

## 5. Tool description and instructions updates

- [x] 5.1 Update the `register_agent` tool description string in `src/mcp/tools.ts` DETECTION block: insert step 0/1 `printenv OPENCODE_XATS_BASE_URL → agent_type='opencode', base_url=<value>, omit session_id`; renumber existing codex/claude-code/custom steps; keep the anti-PATH-probe warning
- [x] 5.2 Add an explicit opencode branch paragraph in the description: pass `base_url=$OPENCODE_XATS_BASE_URL`, omit `session_id` (daemon auto-resolves), `auth_token_ref` only when `OPENCODE_SERVER_PASSWORD` is set
- [x] 5.3 Update top-level MCP server instructions string in `src/mcp/transport.ts` (the `server.setInstructions(...)` block): add a sentence about `agent_type='opencode'` being selected when `OPENCODE_XATS_BASE_URL` is non-empty; preserve all existing guidance
- [x] 5.4 Update tests that assert on the description/instructions substrings: keep existing `CODEX_THREAD_ID` / `CLAUDECODE` / `agent_type="custom"` / anti-PATH assertions; add `OPENCODE_XATS_BASE_URL` assertion; keep `command -v opencode` negative assertion

## 6. Launcher (free-xats-opencode)

- [x] 6.1 Add a README section (both `README.md` and `README.zh-CN.md`) titled "Using opencode with xats" with a copy-pasteable zsh snippet for `free-xats-opencode` that: allocates a free port via `node -e ...`, exports `OPENCODE_XATS_BASE_URL=http://127.0.0.1:<port>`, then `exec opencode --port <port> --hostname 127.0.0.1 "$@"`
- [x] 6.2 Rewrite any existing "opencode + tmux" section in README to point at the new launcher as the recommended path; keep tmux-only as a documented fallback for users who cannot use the launcher
- [x] 6.3 Add a brief example: "After `free-xats-opencode` starts, inside the opencode TUI say: `注册到 xats, name: oc-1, team: default` — the agent picks `agent_type='opencode'` from the env var automatically"

## 7. Archive cleanup

- [x] 7.1 Delete `openspec/changes/archive/2026-04-30-drop-opencode-server-transport/` entirely (proposal.md, design.md, tasks.md, specs/agent-registry/spec.md)
- [x] 7.2 Grep `openspec/` for any remaining references to the deleted archive change and confirm they are unaffected (other changes do not link into it; if any do, leave them — historical proposals can reference archived drops)

## 8. Verification

- [x] 8.1 `pnpm build` — typecheck passes
- [x] 8.2 `pnpm test` — all new and existing tests pass (3 baseline tmux-timeout failures are pre-existing and accepted)
- [x] 8.3 `openspec validate add-opencode-server-transport --strict` passes
- [x] 8.4 `openspec status --change add-opencode-server-transport` reports all artifacts `done`
- [ ] 8.5 Manual E2E (documented in commit message, not automated): launch a temp `opencode --port 18888` in another terminal, set `OPENCODE_XATS_BASE_URL=http://127.0.0.1:18888` in its shell, register via `register_agent({agent_type:'opencode', name:'oc-1', base_url:'http://127.0.0.1:18888'})`, then poke from another agent; confirm the prompt arrives in the opencode TUI as a user message
