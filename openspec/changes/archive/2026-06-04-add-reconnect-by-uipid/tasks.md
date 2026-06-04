## 1. Storage reverse-lookup

- [x] 1.1 Add `findByRuntimeUiPid(ui_pid: number)` to `src/storage/agents-repo.ts` returning matched rows (`agent_id, device, team, name, role, last_seen_at`) for `device='local' AND runtime_ui_pid=?`, ordered by `last_seen_at DESC`, reusing the SQL shape of `reactiveRebindHosts`
- [x] 1.2 Add a unit test covering: zero match, single match, and multi-match ordering by `last_seen_at DESC`

## 2. reconnect tool handler

- [x] 2.1 Create `src/mcp/reconnect.ts` with a handler that takes `{ ui_pid }`, calls `findByRuntimeUiPid`, and branches: 0 → `need_register`, 1 → reuse, N → `ambiguous`
- [x] 2.2 On single match, drive the existing register/takeover/auto-bind path (cross-session takeover + channel auto-bind + runtime-pane auto-bind) using the recovered `(device, team, name)`, and return `{ ok, agent_id, name, team, channel_session_id }`
- [x] 2.3 On zero match, return a `need_register` envelope with a human-readable reason (no row created or mutated)
- [x] 2.4 On multiple matches, return an `ambiguous` envelope with candidates ordered by `last_seen_at DESC` (no row created or mutated)
- [x] 2.5 Include each candidate/match `last_seen_at` in responses to support the PID-reuse staleness advisory

## 3. Tool registration and schema

- [x] 3.1 Register `reconnect` in `src/mcp/tools.ts` with a Zod schema requiring `ui_pid` as a positive integer (reject missing/non-positive at the schema layer)
- [x] 3.2 Write the tool description: state `ui_pid` is the Claude UI process id (`$PPID`) and list the trigger phrases "reconnect xats", "re-register xats", "重连 xats", "重新注册 xats"

## 4. Tests and verification

- [x] 4.1 Add an integration test for `reconnect`: single-match reuses `agent_id` and refreshes `last_seen_at` (registered_at + cursor unchanged); zero-match returns `need_register`; multi-match returns ordered `ambiguous`; remote-device rows are not matched
- [x] 4.2 Add a schema test: `reconnect({ ui_pid: 0 })` and `reconnect({})` are rejected without reading/mutating any row
- [x] 4.3 Build (`tsup`) and run the test suite green
