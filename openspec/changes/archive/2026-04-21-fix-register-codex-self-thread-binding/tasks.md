## 1. Register flow

- [x] 1.1 Update `register_codex_self` input and result types to support explicit `thread_id` and the new `thread_id_required` error.
- [x] 1.2 Change `RegisterCodexSelfService` so explicit `thread_id` is the only path that can register a Codex delivery, while omitted `thread_id` returns a safe error with resumable thread ids.
- [x] 1.3 Preserve existing tmux pane persistence semantics for successful explicit-thread registrations.

## 2. Tool surface and docs

- [x] 2.1 Update the MCP tool schema and description for `register_codex_self` to document explicit `thread_id` binding and the lack of safe auto-detection.
- [x] 2.2 Update Codex-facing docs (`README.md`, `README.zh-CN.md`, `docs/configs/codex-cli.md`) to reflect the new registration flow and safety rationale.

## 3. Tests

- [x] 3.1 Replace the old auto-detect success tests with explicit `thread_id` success coverage.
- [x] 3.2 Add tests for omitted `thread_id` returning `thread_id_required` without mutating agent state.
- [x] 3.3 Add tests for explicit `thread_id` resume failure details and keep existing unsupported-client coverage green.
