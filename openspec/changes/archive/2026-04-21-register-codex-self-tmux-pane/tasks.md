## 1. RegisterCodexSelf service

- [x] 1.1 Extend `register_codex_self` inputs and service wiring to accept optional tmux pane inputs and pane-detect hints
- [x] 1.2 Reuse Codex tmux pane detection during `register_codex_self`, preferring explicit `tmux_pane_id` and treating detection failures as best-effort

## 2. Tooling and documentation

- [x] 2.1 Update MCP tool schemas and descriptions so `register_codex_self` documents the new pane registration behavior
- [x] 2.2 Update Codex-facing documentation to describe `register_codex_self` as the recommended dual registration path

## 3. Verification

- [x] 3.1 Add or update tests for explicit pane ids, detected pane ids, and non-blocking detection failures
- [x] 3.2 Run the targeted test suite and OpenSpec validation for `register-codex-self-tmux-pane`
