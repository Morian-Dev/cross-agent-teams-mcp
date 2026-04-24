## 1. Tool schema

- [x] 1.1 In `src/mcp/tools.ts`, define `registerCodexSelfInputSchema` (strict zod): `name` (non-empty string, required), `model?` (string), `role?` (string), `team?` (string), `project_dir?` (non-empty string), `thread_id?` (non-empty string), `ws_url?` (non-empty string), `auth_token_ref?` (non-empty string)
- [x] 1.2 Confirm the schema uses `.strict()` so passing `ui_pid`, `tmux_pane_id`, `delivery`, `channel_session_id`, `base_url`, `session_id`, or `claude_ui_pid` yields a zod unrecognized-keys error

## 2. Tool registration + wiring

- [x] 2.1 Register `register_codex_self` tool in `src/mcp/tools.ts` with description: explicitly mention `$CODEX_THREAD_ID`, `pre_register_codex_pane`, `project_dir` default-team derivation; describe what happens when `thread_id` is omitted (candidate list via existing `thread_id_required` fallback)
- [x] 2.2 Handler dispatches to the existing `executeRegister` helper with `client: "codex"`, mapping through input fields only — do NOT forward `ui_pid` / `tmux_pane_id` / `delivery` / `channel_session_id`
- [x] 2.3 Default `model` falls back to `gpt` when caller omits it
- [x] 2.4 Tool is callable pre-registration (no `requireAgent()` gate); same stance as `register_claude_self`

## 3. register_agent description update

- [x] 3.1 Extend the `register_agent` description string in `src/mcp/tools.ts` with a one-paragraph codex section: "codex clients SHOULD prefer `register_codex_self`; do NOT pass `ui_pid` — the launcher's `pre_register_codex_pane` handles tmux pane binding"
- [x] 3.2 Keep all existing `register_agent` copy intact; only add the new paragraph

## 4. Server instructions update

- [x] 4.1 Extend the `server.setInstructions` / `instructions` string in `src/mcp/transport.ts` with a codex section: "if `CODEX_THREAD_ID` env is set, pass its value as `thread_id`; prefer `register_codex_self`; do not hunt for `ui_pid`"
- [x] 4.2 Preserve the existing `xats` / team default / "注册" word guard text verbatim — only append

## 5. Tests

- [x] 5.1 Unit test: `register_codex_self` tool schema rejects `ui_pid`, `tmux_pane_id`, `delivery`, `channel_session_id` with a clear zod error
- [x] 5.2 Unit test: `register_codex_self` with `{name, thread_id, ws_url}` routes through the same path as `register_agent({client:"codex", ...})` and yields `delivery.kind="codex-appserver"`
- [x] 5.3 Unit test: `register_codex_self({name})` with no `thread_id` returns the existing `thread_id_required` envelope (parity with `register_agent`)
- [x] 5.4 Unit test: `register_codex_self` description string contains `CODEX_THREAD_ID` and `pre_register_codex_pane`, and does NOT contain `ui_pid` as a recommendation
- [x] 5.5 Unit test: server-level instructions string contains both `CODEX_THREAD_ID` and `register_codex_self`, while preserving the original `xats` guidance
- [x] 5.6 Integration test: end-to-end via MCP tool boundary, `register_codex_self` yields the same registered agent row a `register_agent({client:"codex", name, thread_id, ws_url})` call would

## 6. Spec sync

- [x] 6.1 After green tests, run `openspec validate add-register-codex-self --strict` and fix any structural issues
- [x] 6.2 Do not archive in this pipeline run; archive is decided by the user via `/jt-os-implement --archive`
