## 1. Registry and Runtime Binding

- [x] 1.1 Add runtime binding metadata columns to the `agents` schema and keep migration backward-compatible.
- [x] 1.2 Add a runtime binding helper that verifies `ui_pid -> tty -> pane` and the fallback `ui_tty + tmux_pane_id` path.
- [x] 1.3 Add `bind_runtime_identity` service + MCP tool and persist verified bindings onto the caller row.

## 2. Registration Flow

- [x] 2.1 Remove implicit tmux pane detection from `register_agent` and update its hint text to point callers at `bind_runtime_identity`.
- [x] 2.2 Remove implicit tmux pane detection from `register_codex_self` while preserving Codex delivery registration.
- [x] 2.3 Update tool descriptions so `detect_tmux_pane` is debug-only and `bind_runtime_identity` is the write path.

## 3. Verification

- [x] 3.1 Add unit coverage for pid-based and tty-based runtime binding verification.
- [x] 3.2 Add MCP integration coverage for `bind_runtime_identity` persistence.
- [x] 3.3 Update existing registration tests to the new "no auto-detect at registration time" behavior.
