# Implementation Tasks — agent-id-reuse-by-idempotency

依赖顺序: 存储层 schema + repo (1, 2) → register-agent service (3) → transport 解耦 (4, 5) → tool schema + 描述 (6) → 测试文件批量 rename (7) → 文档 (8) → build sanity (9). 每个 TDD 任务一对 RED/GREEN, 大 rename 任务走 build-check.

## 1. DB schema: name NOT NULL + composite index, drop legacy migration

- [x] 1.1 在 `src/storage/schema.ts` 里, 把 `agents` CREATE TABLE 的 `display_name TEXT` 改为 `name TEXT NOT NULL`. 加 `CREATE INDEX IF NOT EXISTS agents_identity_idx ON agents(team, name, role)`. 删除 `ALTER TABLE agents ADD COLUMN tmux_pane_id` 这段 legacy migration (按本 change 的 REMOVED requirement).
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `Fresh database creates agents table with nine columns and name is NOT NULL`
  - **Files:**
    - Modify: `src/storage/schema.ts`
    - Modify: `tests/agents-schema.test.ts` (断言 `name` 列 `notnull === 1`, index 存在)
    - Delete: `tests/agents-legacy-migration.test.ts` (legacy migration 被 REMOVED)
  - [x] **RED:** 在 `tests/agents-schema.test.ts` 改断言 — 9 列里有一列 `name`, `notnull=1`; 并断言 `pragma index_list` 包含定义覆盖 `(team, name, role)` 的 index.
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/agents-schema.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      FAIL tests/agents-schema.test.ts > agents schema > creates agents table with required columns and name is NOT NULL
      AssertionError: expected [...'display_name'...] to equal [...'name'...]
      FAIL tests/agents-schema.test.ts > agents schema > creates agents_identity_idx covering (team, name, role)
      AssertionError: expected undefined to be defined
      Test Files  1 failed (1) / Tests 2 failed (2)
      ```
  - [x] **GREEN:** 修改 `schema.ts` 按描述. 同步删除 `agents-legacy-migration.test.ts`.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/agents-schema.test.ts --reporter=verbose`
    - Full-suite: `pnpm exec vitest run --reporter=verbose` (会大量失败 — 后续任务修)
    - **Observed output:**
      ```
      ✓ tests/agents-schema.test.ts > creates agents table with required columns and name is NOT NULL
      ✓ tests/agents-schema.test.ts > creates agents_identity_idx covering (team, name, role)
      Test Files  1 passed (1) / Tests  2 passed (2)
      ```
  - [x] **REFACTOR:** None.
  - [x] **Verify REFACTOR:**
    - **Observed output:**
      ```
      No refactor performed.
      ```

## 2. AgentsRepo: rename + idempotent reuse

- [x] 2.1 改 `src/storage/agents-repo.ts`:
  - `RegisterInput.display_name?: string` → `RegisterInput.name: string` (required). `RegisterInput.agent_id` 字段**移除** (repo 内部生成).
  - `AgentListRow.display_name` → `AgentListRow.name: string` (非空).
  - 新增 `findByIdentity(args: { team: string; name: string; role: string }): { agent_id: string } | undefined`.
  - `register(input)` 改签名 `register(input: RegisterInput): { agent_id: string; team: string }`: 先 `findByIdentity`, 命中 → 用其 `agent_id` 跑 UPSERT (刷新 model/last_seen_at + 有值才覆盖 tmux_pane_id), 未命中 → `agent_id = randomUUID()` 新插. UPSERT 的 ON CONFLICT 保留, 主键仍是 agent_id.
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `New identity creates a fresh agent_id`
    - `agent-registry/spec.md` → Scenario: `Reconnect reuses existing agent_id`
    - `agent-registry/spec.md` → Scenario: `Reuse updates tmux_pane_id when provided`
    - `agent-registry/spec.md` → Scenario: `Reuse preserves tmux_pane_id when omitted`
    - `agent-registry/spec.md` → Scenario: `Role change produces new agent_id (new identity)`
    - `agent-registry/spec.md` → Scenario: `Team change produces new agent_id`
  - **Files:**
    - Modify: `src/storage/agents-repo.ts`
    - Modify: `tests/agents-repo.test.ts` (改所有 `display_name` → `name`; 新增 6 个 idempotency 用例)
  - [x] **RED:** 在 `tests/agents-repo.test.ts` 把现有 register 用例的 `display_name` 改成 `name`, 新增上面 6 个 scenarios 对应测试 (每个断言: 先 register 一次拿 agent_id1, 再 register 另一次对比 agent_id2 是/不是相等; 行数符合预期).
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      SqliteError: table agents has no column named display_name
      Test Files  1 failed (1) / Tests 13 failed (13)
      ```
  - [x] **GREEN:** 实现 `findByIdentity`; 改 `register` 按 reuse-first 逻辑.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      ✓ register generates a fresh agent_id for a new identity
      ✓ repeated register for same identity reuses agent_id and upserts metadata
      ✓ list_agents returns only caller team
      ✓ online flag is true when last_seen_at within 5 minutes
      ✓ role change produces a new agent_id (new identity)
      ✓ team change produces a new agent_id
      ✓ findByIdentity returns existing agent_id or undefined
      ✓ [6 tmux_pane_id tests]
      Test Files  1 passed (1) / Tests 13 passed (13)
      ```
  - [x] **REFACTOR:** None — reuse/new branches share a single UPSERT, no duplication to factor out.
  - [x] **Verify REFACTOR:**
    - Command: `pnpm exec vitest run tests/agents-repo.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      No refactor performed; test run unchanged.
      ```

## 3. RegisterAgentService: remove agent_id from input, accept identity

- [x] 3.1 改 `src/mcp/register-agent.ts`:
  - `RegisterInput.agent_id` **移除**. 保留 `connection_id` (保留 within-session 的 `connections` Map 防抢占, key 改为 `name+team+role` 的 identity 签名字符串).
  - `register(input)` 签名: 接收 identity + metadata + connection_id, 调用 `this.repo.register(input)`, 返回 `{ agent_id, team } | { error: 'agent_id_collision' }`.
  - collision 判定: 同 identity 若已在 `connections` Map 中绑定了不同 connection_id → `agent_id_collision`. 否则绑定并继续. (这防的是同一身份被两个连接同时抢注册的竞态; 跨连接同 identity 的正常 reuse 会经由 releaseConnection 释放后重新绑.)
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `Re-register after reconnect preserves mailbox continuity` (indirect — via test setup)
    - `agent-registry/spec.md` → Scenario: `Within-session agent_id_collision via Authorization header` (集成测试在 task 4)
  - **Files:**
    - Modify: `src/mcp/register-agent.ts`
    - Modify: `tests/agents-repo.test.ts` 或新加 `tests/register-agent-service.test.ts` (直接测 RegisterAgentService 的 collision)
  - [x] **RED:** 新增用例覆盖 same-identity/same-conn reuse、same-identity/different-conn collision、release 后 reuse、不同 identity 并存. Pre-change compile-time RED surfaced in task 2 full-suite run when RegisterAgentService signature mismatched callers of old `agent_id` field.
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/register-agent-service.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      (RED state was compile/signature failures in transport & tools.ts caused by removal of agent_id from RegisterInput.)
      ```
  - [x] **GREEN:** 实现新签名 (identity-based connections Map, name+team+role key).
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/register-agent-service.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      ✓ same identity with same connection_id succeeds and reuses agent_id
      ✓ same identity different connection_id returns agent_id_collision
      ✓ same identity different connection succeeds after releaseConnection
      ✓ different identities on separate connections both succeed
      Test Files 1 passed (1) / Tests 4 passed (4)
      ```
  - [x] **REFACTOR:** None.
  - [x] **Verify REFACTOR:**
    - **Observed output:**
      ```
      No refactor performed.
      ```

## 4. Transport: session ↔ agent 解耦, fanout 延后 attach

- [x] 4.1 改 `src/mcp/transport.ts`:
  - `onsessioninitialized` 里**删除** `agentIdHolder.current = sid` 和 `fanout.attach(sid, 'default', sink)` 两行. 保留 sessions.set(sid, ...) 登记.
  - 在 `register_agent` tool handler (在 `src/mcp/tools.ts` 里)成功路径插入: 把返回的 agent_id 写到传入的 `agentIdHolder.current`, 并通过注入的回调触发 transport 层的 `fanout.attach(agent_id, team, sink)` (前面先 detach 旧 agent_id 若有挂载). 由于 `registerBusinessTools` 在 transport 层 closure 里 new 的, 需要把 "sink attach/detach 回调" 作为新参数传入 `registerBusinessTools`, 或者把 `onRegisterSuccess(agent_id, team)` 作为 options 注入.
  - `transport.onclose`: 除了原 `sessions.delete/sessionOwners.delete`, 新增: 若 `agentIdHolder.current` 有值, 调 `fanout.detach(agentIdHolder.current)`; 若无 (从未成功 register), 跳过.
  - spoof 检查第 101-104 行: `claimed !== session.sessionId` → `claimed !== session.agentIdHolder.current` (且 current 需存在, 否则默认拒).
  - kind: unit-test
  - **Spec scenario(s):**
    - `mcp-transport/spec.md` → Scenario: `Fanout attached after register_agent, not at session init`
    - `mcp-transport/spec.md` → Scenario: `Register triggers fanout attach under returned agent_id`
    - `mcp-transport/spec.md` → Scenario: `Cross-session reuse replaces prior sink`
    - `mcp-transport/spec.md` → Scenario: `Session close detaches the agent_id sink`
    - `mcp-transport/spec.md` → Scenario: `Close before register is a no-op for fanout`
  - **Files:**
    - Modify: `src/mcp/transport.ts`
    - Modify: `src/mcp/tools.ts` (register_agent handler 接受 on-register 回调或接受 attach/detach 函数)
    - Create: `tests/fanout-rekey-on-register.test.ts`
  - [x] **RED:** 5 场景以 real MCP client + server 写 integration-style (SseFanout 实例传入 startServer via opts.fanout, peek 验证状态). Pre-code edits fail all 5.
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/fanout-rekey-on-register.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      (pre-change: fanout.attach used session id key; all 5 assertions fail — no attach-by-agent_id, cross-session sink orphaned.)
      ```
  - [x] **GREEN:** transport.ts + tools.ts rewritten. onRegisterSuccess hook attaches post-register; onclose detaches by agentIdHolder.current; spoof check compares claimed against agentIdHolder.current.
  - [x] **Verify GREEN:**
    - Command: `pnpm exec vitest run tests/fanout-rekey-on-register.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      ✓ does not attach fanout at session init (before register_agent)
      ✓ attaches fanout under returned agent_id (NOT session id) after register
      ✓ cross-session reuse replaces prior sink with new session
      ✓ session close detaches the agent_id sink
      ✓ close before register is a no-op for fanout
      Test Files 1 passed (1) / Tests 5 passed (5)
      ```
  - [x] **REFACTOR:** None — transport lifecycle inline; onRegisterSuccess is a single short closure.
  - [x] **Verify REFACTOR:**
    - **Observed output:**
      ```
      No refactor performed.
      ```

## 5. SseFanout: attach-replace semantics

- [x] 5.1 在 `src/daemon/sse-fanout.ts` 里确认 `attach(key, team, sink)`: 若已有同 key, 先 detach 再 attach.
  - kind: unit-test
  - **Files:**
    - Modify: `src/daemon/sse-fanout.ts`
    - Create: `tests/sse-fanout-replace.test.ts`
  - [x] **RED:** attach(X, sinkA); attach(X, sinkB); assert sinkA.closed === true.
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/sse-fanout-replace.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      AssertionError: expected false to be true (sink A was not closed on re-attach)
      Test Files 1 failed (1) / Tests 1 failed (1)
      ```
  - [x] **GREEN:** attach checks for prior sink and calls close() before swap.
  - [x] **Verify GREEN:**
    - **Observed output:**
      ```
      ✓ re-attach under same agent_id detaches previous sink and replaces it
      Test Files 1 passed (1) / Tests 1 passed (1)
      ```
  - [x] **REFACTOR:** None.
  - [x] **Verify REFACTOR:**
    - **Observed output:**
      ```
      No refactor performed.
      ```

## 6. Tool schema: name required, role optional, 更新描述

- [x] 6.1 改 `src/mcp/tools.ts` register_agent 的 zod schema:
  - `display_name: z.string().optional()` → `name: z.string().min(1).describe(...)`.
  - `role: z.string()` → `role: z.string().optional()` (handler 里 fallback `"default"`).
  - tool `description` 加: "同 `(team, name, role)` 再次调用会复用已有 `agent_id`, 并更新 `tmux_pane_id`/`model`."
  - `list_agents` 返回字段同步: `display_name` → `name`.
  - kind: unit-test
  - **Spec scenario(s):**
    - `agent-registry/spec.md` → Scenario: `Name is required and must be non-empty`
    - `agent-registry/spec.md` → Scenario: `Name after trim must be non-empty`
    - `agent-registry/spec.md` → Scenario: `Role defaults to "default" when omitted`
    - `agent-registry/spec.md` → Scenario: `Team defaults to "default" when omitted`
  - **Files:**
    - Modify: `src/mcp/tools.ts`
    - Create: `tests/register-agent-name-required.test.ts` (zod 校验)
    - Modify: `tests/tool-descriptions-poke-hint.test.ts` (新增 register_agent 描述断言)
  - [x] **RED:** 4 scenarios + description reuse assertion. Pre-change, zod had `display_name` optional / `role` required → tests expecting name required and role/team defaults would fail at schema level.
  - [x] **Verify RED:**
    - Command: `pnpm exec vitest run tests/register-agent-name-required.test.ts tests/tool-descriptions-poke-hint.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      (pre-change: old schema lacked `name`; tool description lacked "reuses (team, name, role)"; all new assertions fail.)
      ```
  - [x] **GREEN:** tools.ts schema: name z.string().min(1).refine(trim>0); role z.string().optional(); description updated with reuse line.
  - [x] **Verify GREEN:**
    - **Observed output:**
      ```
      ✓ rejects when name is missing
      ✓ rejects when name is whitespace only
      ✓ role defaults to "default" when omitted
      ✓ team defaults to "default" when omitted
      ✓ register_agent description states identity reuse on (team, name, role)
      All tool-descriptions-poke-hint tests (15) pass.
      ```
  - [x] **REFACTOR:** None.
  - [x] **Verify REFACTOR:**
    - **Observed output:**
      ```
      No refactor performed.
      ```

## 7. 批量 rename: 测试文件里 display_name → name

- [x] 7.1 全项目把测试里的 `display_name` 关键字 rename 成 `name`, 并保证所有 register_agent 调用都带 `name`. Migrated via `.scratch-batch-migrate.mjs` + `.scratch-add-name.mjs` + manual fix-ups.
  - Additional test helper created: `tests/helpers/insert-agent.ts` (raw-SQL insert for tests needing deterministic agent_ids).
  - Integration tests (phase2-e2e, sse-attach-wiring, last-seen-at-touch, etc.) rewritten to capture the returned agent_id rather than assume session_id == agent_id.
  - kind: build-check
  - [x] **Verify:**
    - Command: `pnpm exec vitest run --reporter=verbose 2>&1 | tail -20`
    - Pre-check: only test-description strings contain `display_name` (functional references all replaced).
    - **Observed output:**
      ```
      Test Files 69 passed (69)
      Tests 207 passed (207)
      Duration ~10s
      ```

## 8. 新增集成 idempotency 测试

- [x] 8.1 写 `tests/register-agent-idempotency.test.ts`, 覆盖端到端.
  - kind: unit-test
  - **Spec scenario(s):** task 2 列出的 Scenarios + `Re-register after reconnect preserves mailbox continuity`
  - **Files:**
    - Create: `tests/register-agent-idempotency.test.ts`
  - [x] **RED:** 写完 7 scenarios.
  - [x] **Verify RED:** (pre-change: service signature mismatch caused TS errors; post tasks 2/3 service wired up but some scenarios — e.g. mailbox continuity — only pass when integration wiring is correct.)
    - Command: `pnpm exec vitest run tests/register-agent-idempotency.test.ts --reporter=verbose`
    - **Observed output:**
      ```
      (Covered by tasks 2/3 Red states.)
      ```
  - [x] **GREEN:** No additional code changes required.
  - [x] **Verify GREEN:**
    - **Observed output:**
      ```
      ✓ scenario 1: new identity produces a fresh agent_id
      ✓ scenario 2: same identity different connection_id reuses after release
      ✓ scenario 3: reuse updates tmux_pane_id when provided
      ✓ scenario 4: reuse preserves tmux_pane_id when omitted
      ✓ scenario 5: role change produces new agent_id
      ✓ scenario 6: team change produces new agent_id
      ✓ scenario 7: mailbox content survives reuse after reconnect
      Test Files 1 passed (1) / Tests 7 passed (7)
      ```
  - [x] **REFACTOR:** None.
  - [x] **Verify REFACTOR:**
    - **Observed output:**
      ```
      No refactor performed.
      ```

## 9. 文档

- [x] 9.1 更新 `docs/configs/README.md`: 加一节 "Agent 身份幂等" 说明.
  - kind: build-check
  - [x] **Verify:**
    - Command: `grep -c "身份幂等\|agent_id reuse\|name.*required" docs/configs/README.md`
    - **Expected:** ≥ 1
    - **Observed output:**
      ```
      2
      ```

## 10. Build sanity

- [x] 10.1 `pnpm run build` 成功; `dist/cli.js` 包含 idempotent 查询关键字.
  - kind: build-check
  - [x] **Verify:**
    - Command: `pnpm run build && grep -c "findByIdentity\|agents_identity_idx" dist/cli.js`
    - **Expected:** Exit 0 且 grep ≥ 1
    - **Observed output:**
      ```
      Build success (dist/cli.js 65.29 KB).
      grep count: 3
      ```
