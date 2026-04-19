# Implementation Tasks — add-claude-channel-transport

Dependency order: storage schema (1) → repo (2) → register_agent wiring (3) → fanout primitives (4) → daemon sendChannelWake (5) → new MCP tools (6) → transport dispatch + poke rewrite (7) → channel proxy package (8) → E2E integration (9) → runtime verification (10) → build check (11).  Each code task follows RED → VERIFY RED → GREEN → VERIFY GREEN → REFACTOR → VERIFY REFACTOR.

## 1. Storage schema: add `channel_session_id` column

- [x] 1.1 Add nullable `channel_session_id TEXT` column to `agents` DDL
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `Fresh database creates agents table with channel_session_id column`
  - **Files:**
    - Create: `tests/agents-channel-session-id-column.test.ts`
    - Modify: `src/storage/schema.ts`
  - [x] **RED:** Write a fresh-boot test that applies schema then asserts `PRAGMA table_info('agents')` contains a column named `channel_session_id` with `type='TEXT'` and `notnull=0`.  Expected failure: column missing.
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/agents-channel-session-id-column.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      FAIL tests/agents-channel-session-id-column.test.ts > agents.channel_session_id column > fresh bootstrap creates nullable TEXT channel_session_id column
      expect(csid).toBeDefined()   — csid is undefined (column missing)
      FAIL > rows inserted without channel_session_id default to NULL
      SqliteError: no such column: channel_session_id
      Test Files  1 failed (1)   Tests  2 failed (2)
      ```
  - [x] **GREEN:** Append `, channel_session_id TEXT` to the `CREATE TABLE agents` DDL in `src/storage/schema.ts`.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/agents-channel-session-id-column.test.ts --reporter=verbose`
    - Full-suite: `pnpm exec vitest run --reporter=verbose`
    - **Observed output:**
      ```
      ✓ tests/agents-channel-session-id-column.test.ts (2 tests)   — both pass
      Full suite: Test Files  3 failed | 78 passed (81)  Tests  4 failed | 255 passed (259)
      Note: 4 failures are pre-existing (poke validation expects tmux_pane_not_set before self_poke_denied check), unrelated to this change.
      Also updated tests/agents-schema.test.ts exact-column-list assertion to include channel_session_id.
      ```
  - [x] **REFACTOR:** None — single-line DDL addition.
  - [x] **Verify REFACTOR:**
    - **Observed output:** None run; no refactor performed.
  - [x] **Commit:** `feat(storage): add channel_session_id column to agents table (Task 1.1)`
    - SHA: `24cee92`

## 2. AgentsRepo: accept, persist, and return `channel_session_id`

- [x] 2.1 `RegisterInput` accepts `channel_session_id?: string`; `register()` writes/preserves/overwrites per spec
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `register_agent persists channel_session_id when provided on create`
    - `agent-registry/spec.md` → Scenario: `register_agent preserves channel_session_id when omitted on reuse`
    - `agent-registry/spec.md` → Scenario: `register_agent overwrites channel_session_id when new value provided on reuse`
  - **Files:**
    - Create: `tests/agents-repo-channel-session-id.test.ts`
    - Modify: `src/storage/agents-repo.ts`
  - [x] **RED:** 5 cases — create persists csid, create stores NULL when omitted/blank, reuse preserves when omitted, reuse preserves when blank, reuse overwrites non-blank.
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/agents-repo-channel-session-id.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      Test Files  1 failed (1)   Tests  4 failed | 1 passed (5)
      Main failure: SqliteError via INSERT column mismatch and
      `expected null to be 'csid-new'` — RegisterInput has no csid field.
      ```
  - [x] **GREEN:** Extended `RegisterInput` with `channel_session_id?: string`; added `trimUsable()` helper; INSERT now writes the new column; ON CONFLICT uses `COALESCE(excluded.channel_session_id, channel_session_id)` to preserve-when-null / overwrite-when-provided.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/agents-repo-channel-session-id.test.ts --reporter=verbose`
    - Full-suite: `pnpm exec vitest run`
    - **Observed output:**
      ```
      ✓ 5/5 tests pass
      Full suite: Test Files  3 failed | 79 passed (82)  Tests  4 failed | 260 passed (264)
      (same 4 pre-existing poke failures, unrelated)
      ```
  - [x] **REFACTOR:** `trimUsable()` extracted as module-level helper at the first use site; single call site currently (will be reused in later tasks).
  - [x] **Verify REFACTOR:** n/a (no behavior change).
  - [x] **Commit:** `feat(storage): persist channel_session_id on register (Task 2.1)`
    - SHA: `8cd033e`

- [x] 2.2 `AgentsRepo.list()` includes `channel_session_id` in each row; `AgentListRow` type extended
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `list_agents surfaces channel_session_id`
  - **Files:**
    - Create: `tests/agents-repo-list-channel-session-id.test.ts`
    - Modify: `src/storage/agents-repo.ts`
  - [x] **RED:** Two agents (alice w/ csid, bob w/o) in list output carry `channel_session_id`.
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/agents-repo-list-channel-session-id.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      FAIL > list() returns channel_session_id for each agent (string or null)
      expect(aRow?.channel_session_id).toBe('csid-abc')   — received undefined (not in list)
      Tests  1 failed (1)
      ```
  - [x] **GREEN:** Added `channel_session_id: string | null` to `AgentListRow`; extended SELECT to include column.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/agents-repo-list-channel-session-id.test.ts --reporter=verbose`
    - Full-suite: `pnpm exec vitest run`
    - **Observed output:**
      ```
      ✓ 1/1 test pass
      Full suite: Test Files  3 failed | 80 passed (83)  Tests  4 failed | 261 passed (265)
      (same 4 pre-existing poke failures)
      ```
  - [x] **REFACTOR:** None.
  - [x] **Verify REFACTOR:** n/a.
  - [x] **Commit:** `feat(storage): surface channel_session_id in list (Task 2.2)`
    - SHA: `4294792`

## 3. `register_agent` MCP tool: schema + hint rule

- [x] 3.1 `RegisterAgentService` passes `channel_session_id` through to repo
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `register_agent persists channel_session_id when provided on create`
  - **Files:**
    - Create: `tests/register-agent-service-channel-session-id.test.ts`
    - Modify: `src/mcp/register-agent.ts`
  - [x] **RED:** Service forwards csid → agents row has persisted value.
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/register-agent-service-channel-session-id.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      FAIL > forwards channel_session_id to repo and persists it
      expect(row.channel_session_id).toBe('csid-xyz')   — received null
      ```
  - [x] **GREEN:** Extended service `RegisterInput` with `channel_session_id?: string`; forward to `repo.register()`.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/register-agent-service-channel-session-id.test.ts --reporter=verbose`
    - Full-suite: `pnpm exec vitest run`
    - **Observed output:**
      ```
      ✓ 1/1 pass
      Full suite: Test Files  3 failed | 81 passed (84)  Tests  4 failed | 262 passed (266)
      ```
  - [x] **REFACTOR:** None.
  - [x] **Verify REFACTOR:** n/a.
  - [x] **Commit:** `feat(mcp): forward channel_session_id through RegisterAgentService (Task 3.1)`
    - SHA: `b0135f0`

- [x] 3.2 `register_agent` tool accepts `channel_session_id` in Zod schema; hint rule extended
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `hint triggered when both identifiers missing`
    - `agent-registry/spec.md` → Scenario: `hint suppressed when tmux_pane_id provided alone`
    - `agent-registry/spec.md` → Scenario: `hint suppressed when channel_session_id provided alone`
    - `agent-registry/spec.md` → Scenario: `error envelope never includes hint`
  - **Files:**
    - Create: `tests/register-agent-tool-hint-rule.test.ts`
    - Modify: `src/mcp/tools.ts`
  - [x] **RED:** 5 cases — both missing, tmux alone, csid alone, blank csid, error envelope.
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/register-agent-tool-hint-rule.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      Tests  2 failed | 3 passed (5)
      FAIL > hint present when neither ... expected hint to match /channel_session_id/i (old hint only mentioned tmux_pane_id)
      FAIL > hint suppressed when channel_session_id alone provided (hint still emitted)
      ```
  - [x] **GREEN:** Added `channel_session_id: z.string().optional()` to zod schema; extracted `hasUsableTransportId()` helper at top of file; hint text rewritten to reference both identifiers.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/register-agent-tool-hint-rule.test.ts`
    - Existing test: `pnpm exec vitest run tests/register-agent-hint.test.ts`
    - Full-suite: `pnpm exec vitest run`
    - **Observed output:**
      ```
      ✓ 5/5 new tests pass
      ✓ 6/6 existing register-agent-hint tests still pass (new hint still contains TMUX_PANE and tmux display-message references)
      Full suite: Test Files  3 failed | 82 passed (85)  Tests  4 failed | 267 passed (271)
      ```
  - [x] **REFACTOR:** `hasUsableTransportId()` extracted as a module-level helper from the start — single call site for now.
  - [x] **Verify REFACTOR:** n/a.
  - [x] **Commit:** `feat(mcp): accept channel_session_id in register_agent tool and update hint (Task 3.2)`
    - SHA: `a76be18`

## 4. `ChannelWakeFanout` primitive

- [x] 4.1 `ChannelWakeFanout` class: `attach`, `send`, `detach`, `detachBySession`, re-subscribe semantics
  - kind: unit-test
  - **Spec scenario(s):**
    - `claude-channel-transport/spec.md` → Scenario: `attach and send fan out only to the matched sink`
    - `claude-channel-transport/spec.md` → Scenario: `detach removes sink`
    - `claude-channel-transport/spec.md` → Scenario: `re-subscription replaces prior sink`
    - `claude-channel-transport/spec.md` → Scenario: `detachBySession removes all sinks owned by an MCP session`
  - **Files:**
    - Create: `tests/channel-wake-fanout.test.ts`
    - Create: `src/daemon/channel-wake-fanout.ts`
  - [x] **RED:** All four semantics + `has()` helper.
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/channel-wake-fanout.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      Error: Failed to load url ../src/daemon/channel-wake-fanout.js
      Test Files  1 failed (1)   Tests  no tests
      ```
  - [x] **GREEN:** Implemented `ChannelWakeFanout` with `Map<csid, {sessionId, sink}>`; `send()` returns bool; `has()` helper; `detachBySession()` sweeps by owner session.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/channel-wake-fanout.test.ts`
    - Full-suite: `pnpm exec vitest run`
    - **Observed output:**
      ```
      ✓ 5/5 new tests pass
      Full suite: Test Files  3 failed | 83 passed (86)  Tests  4 failed | 272 passed (276)
      ```
  - [x] **REFACTOR:** Named the `Entry` type for readability.
  - [x] **Verify REFACTOR:** covered by GREEN tests.
  - [x] **Commit:** `feat(daemon): add ChannelWakeFanout primitive (Task 4.1)`
    - SHA: `420e76b`

## 5. `sendChannelWake` daemon function

- [x] 5.1 `sendChannelWake(csid, {content, meta})` emits `notifications/channel_wake`, filters meta keys, returns `no_subscriber`
  - kind: unit-test
  - **Spec scenario(s):**
    - `claude-channel-transport/spec.md` → Scenario: `sendChannelWake emits notifications/channel_wake payload`
    - `claude-channel-transport/spec.md` → Scenario: `meta keys containing hyphens are dropped before send`
    - `claude-channel-transport/spec.md` → Scenario: `sendChannelWake with no subscriber returns no_subscriber`
  - **Files:**
    - Create: `tests/channel-wake-send.test.ts`
    - Create: `src/daemon/channel-wake-send.ts`
  - [x] **RED:** 3 cases — clean payload, bad-key dropped, no subscriber returns no_subscriber.
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/channel-wake-send.test.ts`
    - **Observed output:**
      ```
      Error: Failed to load url ../src/daemon/channel-wake-send.js
      Tests  no tests
      ```
  - [x] **GREEN:** Implemented `sendChannelWake(fanout, csid, {content, meta})` in `src/daemon/channel-wake-send.ts`; `META_KEY_RE` module const; emits the JSON-RPC shape and returns `{ok: true}` or `{ok: false, reason: 'no_subscriber'}`.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/channel-wake-send.test.ts`
    - Full-suite: `pnpm exec vitest run`
    - **Observed output:**
      ```
      ✓ 3/3 tests pass
      Full suite: Test Files  3 failed | 84 passed (87)  Tests  4 failed | 275 passed (279)
      ```
  - [x] **REFACTOR:** `META_KEY_RE` factored out at module top.
  - [x] **Verify REFACTOR:** covered by GREEN tests.
  - [x] **Commit:** `feat(daemon): add sendChannelWake emitter (Task 5.1)`
    - SHA: `074b960`

## 6. New MCP tools: `subscribe_channel_wake`, `bind_channel`

- [x] 6.1 `subscribe_channel_wake` service + tool: role gating, attach sink, detach on session close
  - kind: unit-test
  - **Spec scenario(s):**
    - `claude-channel-transport/spec.md` → Scenario: `subscribe_channel_wake succeeds for __channel_proxy__ caller`
    - `claude-channel-transport/spec.md` → Scenario: `subscribe_channel_wake rejects non-proxy caller`
    - `claude-channel-transport/spec.md` → Scenario: `session close detaches subscriptions`
  - **Files:**
    - Create: `tests/subscribe-channel-wake.test.ts`
    - Create: `src/mcp/subscribe-channel-wake.ts`
    - Modify: `src/mcp/tools.ts` (register tool)
    - Modify: `src/mcp/transport.ts` (thread fanout + detachBySession in onclose)
    - Modify: `src/daemon/server.ts` (instantiate ChannelWakeFanout, pass to mountMcp)
  - [x] **RED:** 4 cases — proxy success, backend forbidden_role, unknown_agent, detachBySession sweeps all owned sinks.
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/subscribe-channel-wake.test.ts`
    - **Observed output:**
      ```
      Error: Failed to load url ../src/mcp/subscribe-channel-wake.js
      Tests  no tests
      ```
  - [x] **GREEN:** Created `SubscribeChannelWakeService` (pure unit-testable); threaded `ChannelWakeFanout` through `buildServer → mountMcp → registerBusinessTools`; registered tool only when fanout is present; `transport.onclose` now calls `channelWakeFanout.detachBySession(sessionId)`.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/subscribe-channel-wake.test.ts`
    - Typecheck: `pnpm exec tsc --noEmit` (clean)
    - Full-suite: `pnpm exec vitest run`
    - **Observed output:**
      ```
      ✓ 4/4 new tests pass
      tsc --noEmit: no output (clean)
      Full suite: Test Files  3 failed | 85 passed (88)  Tests  4 failed | 279 passed (283)
      (same 4 pre-existing poke failures)
      ```
  - [x] **REFACTOR:** Role gate not yet duplicated — will fold together at task 6.2 where `bind_channel` may need the same check.
  - [x] **Verify REFACTOR:** n/a (deferred to 6.2).
  - [x] **Commit:** `feat(mcp): add subscribe_channel_wake service + tool wiring (Task 6.1)`
    - SHA: `<filled after commit>`

- [ ] 6.2 `bind_channel` service + tool: writes csid to target agents row or returns `agent_not_registered`
  - kind: unit-test
  - **Spec scenario(s):**
    - `claude-channel-transport/spec.md` → Scenario: `bind_channel updates agents row when it exists`
    - `claude-channel-transport/spec.md` → Scenario: `bind_channel returns agent_not_registered when row absent`
    - `claude-channel-transport/spec.md` → Scenario: `bind_channel rejects non-proxy caller`
  - **Files:**
    - Create: `tests/bind-channel.test.ts`
    - Create: `src/mcp/bind-channel.ts`
    - Modify: `src/mcp/tools.ts` (register tool)
  - [ ] **RED:** Three cases per spec.
  - [ ] **Verify RED:**
    - Command: `pnpm exec vitest run tests/bind-channel.test.ts --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **GREEN:** Service validates caller role; validates csid trim non-empty; `SELECT agent_id FROM agents WHERE team=? AND name=?`; if missing → `{error:'agent_not_registered'}`; else `UPDATE agents SET channel_session_id=? WHERE team=? AND name=?` → `{ok:true}`.  Register tool.
  - [ ] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/bind-channel.test.ts --reporter=verbose`
    - Full-suite: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **REFACTOR:** Fold common role gating with task 6.1.
  - [ ] **Verify REFACTOR:**
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`

## 7. Transport dispatch + `poke` rewrite

- [ ] 7.1 `transport-dispatch` module: channel-first, tmux fallback, `no_transport_available`
  - kind: unit-test
  - **Spec scenario(s):**
    - `mailbox/spec.md` → Scenario: `poke prefers claude-channel transport when csid set and proxy online`
    - `mailbox/spec.md` → Scenario: `poke falls back to tmux when channel proxy sink absent`
    - `mailbox/spec.md` → Scenario: `poke returns no_transport_available when neither transport configured`
    - `mailbox/spec.md` → Scenario: `poke response envelope carries transport_used on success`
  - **Files:**
    - Create: `tests/transport-dispatch.test.ts`
    - Create: `src/mcp/transport-dispatch.ts`
  - [ ] **RED:** Four cases — dispatcher given a target row `{channel_session_id, tmux_pane_id}` + fanout mock + tmux mock must: (a) use channel when csid + sink, (b) fall through to tmux when no sink, (c) no_transport_available when neither, (d) transport_used on every success.
  - [ ] **Verify RED:**
    - Command: `pnpm exec vitest run tests/transport-dispatch.test.ts --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **GREEN:** `dispatchPoke(deps, row, {content, meta})` where `deps = {fanout, tmuxPoke}`.  Logic per spec D4.
  - [ ] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/transport-dispatch.test.ts --reporter=verbose`
    - Full-suite: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **REFACTOR:** Promote `PokeResult` union to shared type.
  - [ ] **Verify REFACTOR:**
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`

- [ ] 7.2 `poke()` uses dispatcher; response envelope carries `transport_used`; existing tmux path preserved under `transport_used: 'tmux-poke'`
  - kind: unit-test
  - **Spec scenario(s):**
    - Same as 7.1 (integrated through poke entry)
  - **Files:**
    - Create: `tests/poke-channel-transport.test.ts`
    - Modify: `src/mcp/poke.ts`
    - Modify: `src/mcp/tools.ts` (pass fanout into poke deps)
  - [ ] **RED:** Integrate tests — channel path (csid set + sink) returns `{ok:true, transport_used:'claude-channel', channel_session_id}`; tmux path (no csid or no sink) returns `{ok:true, transport_used:'tmux-poke', ...}`; neither → `{error:'no_transport_available', detail:{channel_subscribed:bool, tmux_pane_set:bool}}`.  All existing poke tests must continue passing with transport_used field added.
  - [ ] **Verify RED:**
    - Command: `pnpm exec vitest run tests/poke-channel-transport.test.ts --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **GREEN:** `poke()` loads `channel_session_id` from target row; passes to dispatcher; maps result.  Existing `allowCrossTeam` and self-poke / cross-team checks preserved exactly (run before dispatch).  `PokeDeps` gains optional `channelWakeFanout?: ChannelWakeFanout`.
  - [ ] **Verify GREEN:**
    - Command: `pnpm exec vitest run --reporter=verbose` (run full suite — regressions matter here)
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **REFACTOR:** If existing poke tests fail due to missing `transport_used`, update them to assert the new field rather than ignore it; this is a real contract change.
  - [ ] **Verify REFACTOR:**
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`

## 8. Channel proxy plugin package

- [ ] 8.1 Scaffold `plugins/ts-agent-teams-channel/` package (package.json, tsconfig.json, vitest.config.ts, plugin.json)
  - kind: build-check
  - **Spec scenario(s):** (supporting infra; no scenario)
  - **Files:**
    - Create: `plugins/ts-agent-teams-channel/package.json` (with `bin` entry `ts-agent-teams-channel-proxy`)
    - Create: `plugins/ts-agent-teams-channel/tsconfig.json`
    - Create: `plugins/ts-agent-teams-channel/vitest.config.ts`
    - Create: `plugins/ts-agent-teams-channel/plugin.json`
    - Create: `plugins/ts-agent-teams-channel/README.md`
    - Modify: `pnpm-workspace.yaml` (add `plugins/*`)
  - [ ] **Exit command:** `pnpm -C plugins/ts-agent-teams-channel exec tsc --noEmit`
  - [ ] **Observed output (fill during apply):** `<to be filled by ts-apply>`

- [ ] 8.2 Proxy server declares `capabilities.experimental['claude/channel']: {}` on initialize
  - kind: unit-test
  - **Spec scenario(s):**
    - `claude-channel-transport/spec.md` → Scenario: `proxy declares claude/channel experimental capability`
  - **Files:**
    - Create: `plugins/ts-agent-teams-channel/tests/proxy-capability.test.ts`
    - Create: `plugins/ts-agent-teams-channel/src/proxy.ts`
  - [ ] **RED:** Spawn proxy, send `initialize` over stdio, assert `capabilities.experimental['claude/channel']` equals `{}`.
  - [ ] **Verify RED:**
    - Command: `pnpm -C plugins/ts-agent-teams-channel exec vitest run tests/proxy-capability.test.ts --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **GREEN:** Use `@modelcontextprotocol/sdk/server/mcp.js` `McpServer` with `capabilities: {experimental: {'claude/channel': {}}}`.  Minimal no-tool server sufficient at this step.
  - [ ] **Verify GREEN:**
    - Command: `pnpm -C plugins/ts-agent-teams-channel exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **REFACTOR:** None.
  - [ ] **Verify REFACTOR:**
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`

- [ ] 8.3 Proxy resolves `channel_session_id` from persistence (read if exists, generate+write if absent)
  - kind: unit-test
  - **Spec scenario(s):**
    - `claude-channel-transport/spec.md` → Scenario: `proxy recovers csid from persistence when file exists`
    - `claude-channel-transport/spec.md` → Scenario: `proxy generates fresh csid when persistence absent`
  - **Files:**
    - Create: `plugins/ts-agent-teams-channel/tests/proxy-csid-persistence.test.ts`
    - Create: `plugins/ts-agent-teams-channel/src/csid-store.ts`
  - [ ] **RED:** Two cases — (a) pre-write file, expect read matches; (b) no file, expect generated UUID and file written.  Use tmp dir override via arg.
  - [ ] **Verify RED:**
    - Command: `pnpm -C plugins/ts-agent-teams-channel exec vitest run tests/proxy-csid-persistence.test.ts --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **GREEN:** `csid-store.ts` exports `resolveCsid({cacheDir, team, name}): string`.  Path `<cacheDir>/ts-agent-teams-channel/<team>-<name>.json` with `{channel_session_id}`.  Create dirs as needed.  Use `node:crypto.randomUUID()`.
  - [ ] **Verify GREEN:**
    - Command: `pnpm -C plugins/ts-agent-teams-channel exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **REFACTOR:** Normalize cacheDir resolution (XDG / HOME / LOCALAPPDATA) in a helper.
  - [ ] **Verify REFACTOR:**
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`

- [ ] 8.4 Proxy connects to daemon + executes registration sequence (register_agent → bind_channel → subscribe_channel_wake)
  - kind: integration-test
  - **Spec scenario(s):**
    - `claude-channel-transport/spec.md` → Scenario: `proxy retries bind_channel with backoff when agent not yet registered` (order only; backoff tested separately in 8.5)
  - **Files:**
    - Create: `plugins/ts-agent-teams-channel/tests/proxy-registration-sequence.test.ts`
    - Modify: `plugins/ts-agent-teams-channel/src/proxy.ts`
  - [ ] **RED:** Fake daemon HTTP MCP server records tool calls.  Spawn proxy with fake url + agent-team + agent-name.  Assert order: `initialize` → `register_agent` (role=`__channel_proxy__`) → `bind_channel` (team, name, csid) → `subscribe_channel_wake`.
  - [ ] **Verify RED:**
    - Command: `pnpm -C plugins/ts-agent-teams-channel exec vitest run tests/proxy-registration-sequence.test.ts --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **GREEN:** Use `@modelcontextprotocol/sdk` Streamable HTTP client; open session; sequential tool calls with JSON args.  CLI parsing: read `--daemon-url`, `--agent-team`, `--agent-name`, env fallback `TS_AGENT_TEAMS_DAEMON_URL`.
  - [ ] **Verify GREEN:**
    - Command: `pnpm -C plugins/ts-agent-teams-channel exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **REFACTOR:** Split into `connect()`, `register()`, `bind()`, `subscribe()` for clarity.
  - [ ] **Verify REFACTOR:**
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`

- [ ] 8.5 Proxy retries `bind_channel` with exponential backoff on `agent_not_registered`
  - kind: integration-test
  - **Spec scenario(s):**
    - `claude-channel-transport/spec.md` → Scenario: `proxy retries bind_channel with backoff when agent not yet registered`
  - **Files:**
    - Create: `plugins/ts-agent-teams-channel/tests/proxy-bind-retry.test.ts`
    - Modify: `plugins/ts-agent-teams-channel/src/proxy.ts`
  - [ ] **RED:** Fake daemon returns `agent_not_registered` for first N bind_channel calls, then `{ok:true}`.  Assert proxy eventually succeeds; record timestamps to sanity-check backoff grows (first gap < second gap within epsilon).
  - [ ] **Verify RED:**
    - Command: `pnpm -C plugins/ts-agent-teams-channel exec vitest run tests/proxy-bind-retry.test.ts --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **GREEN:** Retry loop: `delay = min(500 * 2^attempt, 30000)`; jitter ±15%.  Stop on any non-`agent_not_registered` result.  Propagate other errors.
  - [ ] **Verify GREEN:**
    - Command: `pnpm -C plugins/ts-agent-teams-channel exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **REFACTOR:** Make backoff params injectable for test speedup.
  - [ ] **Verify REFACTOR:**
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`

- [ ] 8.6 Proxy reconnects to daemon on disconnect; re-executes register → bind → subscribe
  - kind: integration-test
  - **Spec scenario(s):**
    - `claude-channel-transport/spec.md` → Scenario: `proxy reconnects and re-subscribes after daemon disconnect`
  - **Files:**
    - Create: `plugins/ts-agent-teams-channel/tests/proxy-reconnect.test.ts`
    - Modify: `plugins/ts-agent-teams-channel/src/proxy.ts`
  - [ ] **RED:** Proxy subscribed; fake daemon closes transport; assert proxy retries HTTP connect within 2s; on reconnect, order is `register_agent` → `bind_channel` → `subscribe_channel_wake`.
  - [ ] **Verify RED:**
    - Command: `pnpm -C plugins/ts-agent-teams-channel exec vitest run tests/proxy-reconnect.test.ts --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **GREEN:** Catch transport close → run reconnect loop with same backoff params as bind retry → re-run registration sequence from scratch.
  - [ ] **Verify GREEN:**
    - Command: `pnpm -C plugins/ts-agent-teams-channel exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **REFACTOR:** Extract `connectWithRetry()` if not already.
  - [ ] **Verify REFACTOR:**
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`

- [ ] 8.7 Proxy relays daemon `notifications/channel_wake` as `notifications/claude/channel` to host; survives host stdio close
  - kind: unit-test
  - **Spec scenario(s):**
    - `claude-channel-transport/spec.md` → Scenario: `proxy relays channel_wake as claude/channel notification`
    - `claude-channel-transport/spec.md` → Scenario: `proxy drops relay without crashing when host stdio is closed`
  - **Files:**
    - Create: `plugins/ts-agent-teams-channel/tests/proxy-relay.test.ts`
    - Modify: `plugins/ts-agent-teams-channel/src/proxy.ts`
  - [ ] **RED:** Two cases — (a) host side fake MCP client receives relayed notification with params unchanged, (b) host stdio closed, daemon sends wake, proxy logs to stderr but process does not exit.
  - [ ] **Verify RED:**
    - Command: `pnpm -C plugins/ts-agent-teams-channel exec vitest run tests/proxy-relay.test.ts --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **GREEN:** Register notification listener for `channel_wake` on daemon client; call host server's `notification({method:'notifications/claude/channel', params})`.  Wrap host send in try/catch; on closed-transport error, log and continue.
  - [ ] **Verify GREEN:**
    - Command: `pnpm -C plugins/ts-agent-teams-channel exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **REFACTOR:** None.
  - [ ] **Verify REFACTOR:**
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`

## 9. End-to-end integration

- [ ] 9.1 Real daemon + real proxy subprocess: `poke` via channel triggers `notifications/claude/channel` on proxy's host stdio; no tmux command executed
  - kind: integration-test
  - **Spec scenario(s):**
    - `claude-channel-transport/spec.md` → Scenario: `end-to-end poke via channel transport`
  - **Files:**
    - Create: `tests/e2e-channel-poke.test.ts`
  - [ ] **RED:** Start daemon on random port; start proxy subprocess with fake host stdio reader; register `bob` with csid matching proxy; register `alice` same team; `alice` calls `poke`; assert proxy's fake host receives `notifications/claude/channel` and `poke` response `transport_used==='claude-channel'`; assert NO tmux command spawned (stub `child_process.spawn` and verify no invocation).
  - [ ] **Verify RED:**
    - Command: `pnpm exec vitest run tests/e2e-channel-poke.test.ts --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **GREEN:** All prior tasks should already satisfy this; if integration plumbing missing, wire ChannelWakeFanout into daemon bootstrap and expose it to `poke` through tool registration.
  - [ ] **Verify GREEN:**
    - Command: `pnpm exec vitest run --reporter=verbose`
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`
  - [ ] **REFACTOR:** None expected.
  - [ ] **Verify REFACTOR:**
    - **Observed output (fill during apply):** `<to be filled by ts-apply>`

## 10. Runtime verification (manual)

- [ ] 10.1 Real Claude Code instance with dev channel plugin: verify `poke` delivers channel hint while host Claude is (a) idle and (b) mid-turn generating
  - kind: manual-verify
  - **Spec scenario(s):** End-to-end coverage for all `claude-channel-transport` scenarios that depend on real Claude Code behavior (Channels protocol acceptance).
  - **Runtime setup (procedure):**
    1. `pnpm -C plugins/ts-agent-teams-channel build`
    2. Add `.mcp.json` entry for the plugin with `--agent-team ... --agent-name ...`
    3. Start daemon; verify proxy appears as agent with role `__channel_proxy__` in `list_agents`
    4. Launch Claude Code with `--channels plugin:ts-agent-teams-channel@dev --dangerously-load-development-channels`
    5. From another agent session call `poke({target_agent_id: <owner>})`
    6. Case (a) host Claude idle: capture Claude Code's visible response within 10s
    7. Case (b) host Claude mid-turn (deliberately started a long generation): call `poke`, capture Claude's observable reaction and whether current turn completes cleanly
  - **Required evidence** (commit to `openspec/changes/add-claude-channel-transport/evidence/`):
    - `runtime-idle-pane.txt` — `tmux capture-pane` output of host pane within 10s of poke (idle case)
    - `runtime-midturn-pane.txt` — same for mid-turn case
    - `runtime-wire.jsonl` — proxy stderr log lines capturing `channel_wake` received and `claude/channel` emitted
    - `runtime-notes.md` — pass/fail judgement per case with timestamps
  - [ ] **Observed output (fill during apply):** `<to be filled by ts-apply>`

## 11. Build exit check

- [ ] 11.1 Full repo tsc noEmit + full vitest suite pass (root + plugin workspaces)
  - kind: build-check
  - **Spec scenario(s):** all
  - [ ] **Exit commands:**
    - `pnpm exec tsc --noEmit`
    - `pnpm -C plugins/ts-agent-teams-channel exec tsc --noEmit`
    - `pnpm exec vitest run --reporter=verbose`
    - `pnpm -C plugins/ts-agent-teams-channel exec vitest run --reporter=verbose`
  - [ ] **Observed output (fill during apply):** `<to be filled by ts-apply>`
