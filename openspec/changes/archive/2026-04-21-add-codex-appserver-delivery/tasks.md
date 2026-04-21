## 1. Validator And Registry

- [x] 1.1 Update `src/lib/delivery-spec.ts` to accept `codex-appserver` on write, validate `thread_id` / `ws_url` / `auth_token_ref`, and expose the new machine-readable rejection reasons
- [x] 1.2 Update `src/mcp/register-agent.ts` and `src/mcp/tools.ts` so `register_agent` persists `codex-appserver` delivery and suppresses the tmux hint when a non-tmux delivery is provided
- [x] 1.3 Update delivery and register-agent tests for the new accepted `codex-appserver` path and the delivery-aware hint behavior

## 2. Codex Dispatcher

- [x] 2.1 Add a dedicated Codex app-server dispatcher module that resolves `auth_token_ref`, opens the websocket client, and executes `initialize -> initialized -> thread/resume -> turn/start`
- [x] 2.2 Wire `src/mcp/transport-dispatch.ts` and `src/mcp/poke.ts` to return transport-aware Codex success and failure envelopes, with no automatic tmux fallback for explicit `codex-appserver` delivery
- [x] 2.3 Add focused unit tests for Codex dispatcher success, token resolution failure, websocket connection failure, initialize failure, resume failure, and turn/start failure

## 3. Integration Coverage

- [x] 3.1 Update route-level tests such as `tests/transport-dispatch.test.ts`, `tests/poke-dispatch-routing.test.ts`, and `tests/poke-validation.test.ts` to cover real `codex-appserver` routing semantics
- [x] 3.2 Ensure auto-poke surfaces still work when `poke()` returns a Codex transport result, and add any missing regression coverage for callers that expect transport-aware results

## 4. Docs And Verification

- [x] 4.1 Update user-facing docs, including `docs/configs/codex-cli.md` and root `README.md`, to document Codex app-server startup, `register_agent.delivery`, and optional `auth_token_ref`
- [x] 4.2 Run the targeted test suite and `openspec validate add-codex-appserver-delivery`, then fix any failures until the change is apply-ready
