## 1. Codex endpoint resolution

- [x] 1.1 Add validated multi-endpoint environment parsing with explicit, legacy single, multi-endpoint, and built-in precedence.
- [x] 1.2 Probe configured candidates by `thread_id`, persist the unique matched `ws_url`, and fail closed for zero or ambiguous matches.
- [x] 1.3 Preserve existing explicit `ws_url` and single-endpoint diagnostic behavior.

## 2. Registration tests

- [x] 2.1 Add unit tests for multi-endpoint JSON validation, de-duplication, and precedence.
- [x] 2.2 Add tests for unique endpoint matching, zero matches, ambiguous matches, and no agent-row mutation on failure.
- [x] 2.3 Run the focused Codex registration and app-server test suites.

## 3. Dual runtime launcher documentation

- [x] 3.1 Update `README.agent.md` launcher functions to start isolated CLI and App app-servers on 8799 and 8800 with separate logs and lifecycle handling.
- [x] 3.2 Require the optional App runtime to use the current App bundle Codex binary without PATH fallback, and document the external app-server Chrome limitation.
- [x] 3.3 Document independent CLI `CODEX_HOME` creation, login, MCP setup, migration, and SSH usage without copying App auth state.
- [x] 3.4 Update root README files and Codex launcher/config guides to match the dual runtime architecture.
- [x] 3.5 Ask whether the user wants App xats before setup, default to CLI-only, and conditionally manage port 8800.

## 4. Verification

- [x] 4.1 Run OpenSpec verification and resolve all critical or warning findings.
- [x] 4.2 Run formatting, type checking, and the complete automated test suite.
- [x] 4.3 Record the verified App xats poke flow, the Chrome plugin limitation, and the native App alternative without changing the user's active runtime automatically.
