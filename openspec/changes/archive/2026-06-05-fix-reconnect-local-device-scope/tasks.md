## 1. Scope the reverse lookup to the daemon's local device

- [x] 1.1 Change `AgentsRepo.findByRuntimeUiPid` to accept the daemon's resolved local device label and filter `WHERE device = ?` on it, replacing the hardcoded `WHERE device = 'local'`.
- [x] 1.2 In the `reconnect` handler (`src/mcp/tools.ts`), thread the daemon's local device label into the lookup — the same value passed to `RegisterAgentService` as `deps.localDevice`; do not re-derive it deeper in the stack.
- [x] 1.3 Update `src/mcp/reconnect.ts` (`resolveReconnect` / handler) to pass the resolved device through to `findByRuntimeUiPid`.

## 2. Audit the sibling default

- [x] 2.1 Inspect `const device = input.device ?? 'local'` at `src/storage/agents-repo.ts:119`; confirm every caller passes the resolved device. If a real gap exists, fix it surgically; otherwise leave it unchanged and note the audit result in the PR/commit message.

## 3. Regression test

- [x] 3.1 Add a test: a daemon with `localDevice='jt'` (agents stored under `device='jt'`) MUST resolve `reconnect(ui_pid)` to that agent — proving the literal `'local'` no longer causes a miss.
- [x] 3.2 Add/keep a test for the no-`--device` case (label resolves to `'local'`) to prove single-host behavior is preserved.
- [x] 3.3 Add a test that a row on a different device label is NOT matched (scope isolation), returning `need_register` when no local-device row matches.

## 4. Verify

- [x] 4.1 Run the full test suite (`vitest`) — all green.
- [x] 4.2 Run `openspec validate --specs` — passes.
