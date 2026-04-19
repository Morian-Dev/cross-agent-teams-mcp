## Why

Ghost 累积的根因是 `src/mcp/transport.ts:29` `sessionIdGenerator: () => randomUUID()` 加 `agentIdHolder.current = sid` — 每次 MCP 重连都是新 agent_id, 数据库里旧 row 永不复用. 已落地的 P0 `fix-fanout-skip-offline` 只在 fan-out 时 filter offline, 治标不治本. P2 要从源头消掉重复 row: 同一身份 (team + name + role) 重连时复用已有 agent_id.

用户选择 B 方案"P2 直接做, 免掉 P1 GC": P2 落地后 ghost 不再产生, P1 背景 GC 的必要性大幅下降 (仅用于清理少量历史残留或身份变更产生的 orphan, 后续视需要再做).

关键设计决策 (已与用户确认):

1. **身份键 = 3 元组 `(team, name, role)`**. `tmux_pane_id` 不参与识别 (agent 可能换 pane, 但仍是同一个"人"). `tmux_pane_id` 在 reuse 时会被新值覆盖, 便于 pane 迁移后 `poke` 路由正确.
2. **`display_name` 重命名为 `name`**, 同时从 optional 变 **required**. 理由: 身份键必须非空且可读; 没名字就不知道"发给谁". `team` 和 `role` 仍 optional, 缺省 `"default"`.
3. **跨 session 复用不做 auth 校验**. Authorization 在本项目 MVP 阶段仅是软标识, 纯幂等. 同 session 内换 Authorization 仍触发现有 409 `agent_id_collision` 保护.
4. **SSE fanout 重新按 agent_id 绑定**: `fanout.attach` 从 `onsessioninitialized` 挪到 `register_agent` 成功之后, key 改为最终 agent_id. 同一 agent_id 再次 attach 时先 detach 旧连接.
5. **不做 legacy migration**: 按 `feedback_skip_legacy_db_migration` 记忆, MVP 阶段假设 fresh-boot; rename column + 改 schema 不提供迁移路径.

## What Changes

- **MODIFIED**: `src/storage/agents-repo.ts`
  - `RegisterInput.display_name?: string` → `RegisterInput.name: string` (required)
  - `AgentListRow.display_name` → `AgentListRow.name`
  - `register(input)` 新逻辑: 先 `SELECT agent_id FROM agents WHERE team=? AND name=? AND role=?`. 命中 → 用其 agent_id 跑 UPSERT (刷新 model/tmux_pane_id/last_seen_at), 返回该 agent_id. 未命中 → 生成 `randomUUID()` 插入新 row.
  - 新增 `findByIdentity(team, name, role): { agent_id: string } | undefined` (供 transport 层或测试断言使用).
  - DB schema 列: `display_name TEXT` → `name TEXT NOT NULL`.

- **MODIFIED**: `src/mcp/register-agent.ts`
  - `RegisterInput.agent_id` 字段**移除** — 不再由调用方 (transport) 预先决定, 改由 repo 的 register 返回. 签名变为 `register(input)` 返回 `{ agent_id, team }`.
  - 内部 `connections: Map<agent_id, connection_id>` 约束仍保留.

- **MODIFIED**: `src/mcp/transport.ts`
  - 删除 `onsessioninitialized` 里的 `agentIdHolder.current = sid` 和 `fanout.attach(sid, ...)`.
  - `register_agent` tool 成功后: `agentIdHolder.current = returned_agent_id`; `fanout.attach(returned_agent_id, team, sink)` (若已有同 agent_id 挂载则先 `fanout.detach`).
  - spoof 检查: `claimed !== agentIdHolder.current` (原为 `session.sessionId`).
  - `sessionOwners` 内存机制**保留** (同 session 换 Authorization 仍 409).
  - session 断开 (`transport.onclose`): detach by 当前 agent_id (若已注册) 或 session_id (若未注册就断开).

- **MODIFIED**: `src/daemon/sse-fanout.ts`
  - API 不变 (attach/detach/emit 已经是字符串 key), 但调用方传入的 key 从 sid 改为 agent_id. 同 agent_id 的 attach 行为: 先 detach 旧 sink 再装新. 新增 test 覆盖这个替换语义.

- **MODIFIED**: `src/mcp/tools.ts` `register_agent` 的 tool description 和 input schema
  - `display_name: z.string().optional()` → `name: z.string().min(1)` (required).
  - `role: z.string()` → `role: z.string().optional()` (default "default", 在 handler 里 fallback).
  - 描述里加: "同 `(team, name, role)` 再次注册会复用已有 `agent_id`, 更新 `tmux_pane_id` 和 `model`.".

- **MODIFIED**: `openspec/specs/agent-registry/spec.md`
  - Requirement "Agents table schema": column 从 `display_name TEXT` 改为 `name TEXT NOT NULL`, 从 9 列保持 9 列.
  - Requirement "register_agent uses MCP session id as agent_id": 整条**重写**为新身份模型 "register_agent reuses agent_id by (team, name, role) identity".
  - Requirement "Repeated register_agent within same session updates metadata": 保留, 语义覆盖为"同身份的再次注册, 不论是否同 session".
  - Requirement "agent_id collision across sessions returns 409": **保留但收窄**为"同 session 内换 Authorization 仍 409"; 跨 session 无 auth 校验.
  - Requirement "Mismatched agent_id for session returns 403": 保留, 但内部检查对象改为 `agentIdHolder.current`.

- **MODIFIED**: `openspec/specs/mcp-transport/spec.md`
  - 新增 Requirement "SSE fanout keyed by agent_id after register_agent": attach 延后到 register 成功, key = 最终 agent_id; 同 agent_id 重复 attach 先 detach 旧.

- **MODIFIED**: 测试
  - 25 处测试 `display_name` → `name`.
  - 新增 `tests/register-agent-idempotency.test.ts`: 覆盖 reuse 路径, `tmux_pane_id` 覆盖, name 缺失报错, role/team 默认值, 跨 session 同身份复用.
  - 新增 `tests/fanout-rekey-on-register.test.ts`: 覆盖 fanout 延后 attach 和替换语义.
  - 更新所有 register_agent 测试移除 `display_name`, 添加 `name`.

- **MODIFIED**: `docs/configs/README.md`
  - 新增一节说明 "身份幂等: 同 team+name+role 重连复用 agent_id" + `name` required 的新 schema.

## Capabilities

### Modified Capabilities

- `agent-registry`:
  - MODIFIED: Agents table schema (column rename + not null)
  - MODIFIED: register_agent 的身份逻辑 (3 元组复用)
  - MODIFIED: within-session auth collision 保留; cross-session 纯幂等
- `mcp-transport`:
  - ADDED: SSE fanout keyed by agent_id after register_agent

### New Capabilities

(无)

## Impact

- **DB schema 变化**: `display_name` column rename 为 `name` 并加 NOT NULL. 按 fresh-boot 假设, 不写 migration. 已有开发库需要手工 drop + 重建.
- **Wire format 变化 (breaking)**: `register_agent` input 的 `display_name` 字段重命名为 `name`, 且变成 required. 旧 client (传 `display_name`) 会被 zod schema 拒绝. 用户已确认本项目仅用于本地手工启动 agent, 没有第三方集成受影响.
- **响应 shape 变化**: `list_agents` 每行 `display_name: string | null` → `name: string` (不再可空).
- **运行时行为**:
  - 同 `(team, name, role)` 重连 → `recipients` 数组里看到同一个 `agent_id` (ghost 消失).
  - `tmux_pane_id` 在 reuse 时会被新值覆盖 (pane 迁移后 poke 立即路由到新 pane).
  - `fanout.emit(agent_id, ...)` 自动路由到最新 session; 旧 session 的 SSE 连接已 detach.
- **回滚**: 单次 revert commit. 无状态迁移需逆向.
- **性能**: register_agent 多一次 SELECT, O(1) 索引 (agents 表 team+name+role 需要 composite index 加速, tasks 中包含).

## 与后续 change 的关系

- **P0 `fix-fanout-skip-offline` (done)**: 运行时 online filter. P2 落地后 ghost 不再产生, online filter 的主要应用场景转为"真正 idle > 5 min 的 live agent". 两者独立, P2 不需要改 P0 的代码.
- **P1 `add-agent-registry-gc` (跳过)**: 原计划的后台 GC. P2 落地后 ghost 不再增长, P1 不再必要. 若未来观察到历史残留或身份变更留下 orphan, 再补小范围 cleanup 脚本.

## 与现有 Mailbox 契约的交互

本 change 不改 Mailbox 任何行为. `send_message`/`broadcast`/`get_inbox` 仍按 agent_id 操作 mailbox, 只是 agent_id 现在是"稳定身份" 而非"每次重连新值". Offline delivery via events outbox 契约不变.
