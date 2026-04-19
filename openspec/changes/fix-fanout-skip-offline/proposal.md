## Why

Steward (管家) 2026-04-19 报告, e2e 自证: team=default 里积累了 30+ 条 ghost agents rows (offline > 5min 到多天的 stale session). 每次 `broadcast` 或 `send_message({to_role})` fan-out 都把死 ghost 也列为 recipient, 后果:

- **噪音**: kimi 19:26 的 broadcast 返回 `recipients=28, 多数 guard_failed/no_pane`. 有效目标不到 3 个, 其余 25 个是 ghost.
- **性能**: quiet-guard 对每个 ghost pane 跑 2s (并行), daemon CPU 无意义占用; guard_failed 后还排 3 次 retry (30s / 180s / 600s), 无效 setTimeout 挂起.
- **mailbox 污染**: 每个 ghost 都得到一行 messages (永不被读, 因为对应 session 已死), DB 行数线性增长.
- **pane 噪音**: 真 live 的 agent (比如我 opus, pane=%71) 在 agents 表里有多条 ghost row (因为每次 MCP reconnect 都发新 agent_id). broadcast 给每条发一份 → 同一个 live pane 被 hint 多次注入.

根因是架构决定: `agent_id = MCP session id`, 每次 initialize 都 `randomUUID()`. 旧 session 的 row 不删, 永久累积. 真正修根需要 P2 agent_id 复用 (大改), P1 GC (中改). **本 P0 只止血**: fan-out 时跳过 offline, ghost 不再参与.

关键设计决策: 对于 **send_message 的 `to_agent_id` 单发路径**, 不过滤 online — 单发是精确寻址, 调用方知道目标即便离线也要 mailbox 落盘供将来读. 仅对 **按 role 或 broadcast** 的 fan-out 场景过滤.

Online 阈值沿用现有常量: `AgentsRepo.ONLINE_MS = 5 * 60 * 1000` (5 分钟, `last_seen_at` 更新于每次 MCP 调用 via `touchIfRegistered`).

## What Changes

- **MODIFIED**: `src/mcp/broadcast.ts` `SELECT` 添加 online 过滤. 当前:
  ```ts
  this.db.prepare('SELECT agent_id, tmux_pane_id FROM agents WHERE team=? AND agent_id != ?')
    .all(fromRow.team, input.from)
  ```
  改为:
  ```ts
  const cutoff = new Date(Date.now() - ONLINE_MS).toISOString()
  this.db.prepare('SELECT agent_id, tmux_pane_id FROM agents WHERE team=? AND agent_id != ? AND last_seen_at > ?')
    .all(fromRow.team, input.from, cutoff)
  ```
- **MODIFIED**: `src/mcp/send-message.ts` 的 `to_role` 分支相同改动:
  ```ts
  const cutoff = new Date(Date.now() - ONLINE_MS).toISOString()
  this.db.prepare('SELECT agent_id, tmux_pane_id FROM agents WHERE role=? AND team=? AND last_seen_at > ?')
    .all(input.to_role!, team, cutoff)
  ```
  单发 `to_agent_id` 分支**不变** (精确寻址 + mailbox 延迟送达).
- **EXPORTED**: `AgentsRepo.ONLINE_MS` 改为命名导出 (或新建 `src/storage/online-threshold.ts` 导出常量). 避免 broadcast/send-message 复写魔数.
- **MODIFIED**: `src/mcp/tools.ts` `send_message` 与 `broadcast` tool description 补充: "role-based routing and broadcast skip offline (> 5 min idle) agents; direct `to_agent_id` always delivers."
- **ADDED**: `tests/fanout-skip-offline.test.ts` 覆盖 3 个新场景:
  1. broadcast skips offline recipients (mix of online + offline panes)
  2. send_message to_role skips offline; still returns unknown_recipient when ALL matching are offline
  3. send_message single-recipient to_agent_id IGNORES online state (preserves offline delivery)
- **MODIFIED**: 现有 `tests/send-role-broadcast.test.ts` / `tests/broadcast-auto-poke.test.ts` — 检查是否有用例依赖"所有注册 agent 都列入 fan-out" (即使 last_seen 很久). 若有, 更新测试在 setup 里 `touch` 让它们 online.
- **ADDED**: `openspec/specs/mailbox/spec.md` 新 Requirement "Fan-out routing skips offline recipients".
- **MODIFIED**: `docs/configs/README.md` 补一小节说明新行为 + 5 min 阈值来源.

## Capabilities

### Modified Capabilities

- `mailbox`:
  - ADDED Requirement: `Fan-out routing skips offline recipients` — 规定 broadcast / to_role 跳过 offline, 单发不跳过.
  - `list_agents` 行为**不变** (仍返回全部, 含 `online` 字段), 保留 debug/排查能力.

### New Capabilities

(无)

## Impact

- **不改 DB schema**.
- **不改 wire format**.
- **语义变化**:
  - `broadcast` 的 `recipients` 数组会变短 (只含 online). 同样 `send_message({to_role})`.
  - 若 role 下**无任何 online** agent, `send_message({to_role})` 返回 `{ error: "unknown_recipient" }` (与现有"无匹配"行为一致, 语义上说"没人在线").
  - `send_message({to_agent_id: X})` 不论 X 是否 online 都照常落盘 — 不破坏 Mailbox 的 offline-delivery 契约 (该契约仅覆盖单发).
- **性能**: 每次 fan-out SQL 查询多一个参数和比较, 索引影响极小. fan-out 本身耗时减少 (不再等 ghost guards).
- **回滚**: 单次 revert commit 即可回退. 无状态迁移.

## 与后续 change 的关系

- **P1 (`add-agent-registry-gc`)**: 加后台 GC 清理长期 offline row. 本 P0 是运行时过滤, P1 是存储清理, 两者互补, 可独立并行.
- **P2 (`agent-id-reuse-by-idempotency`)**: 改 register_agent 按 `(team, tmux_pane_id, display_name, role)` 复用 agent_id. 本 P0 不依赖 P2, 且 P2 落地后 ghost 数量从源头下降, 本 P0 的 filter 仍有价值 (处理真正 idle > 5 min 的 live agent).

## 与现有 Mailbox 契约的交互

检查现有 `openspec/specs/mailbox/spec.md` 的 `Offline delivery via events outbox` Requirement: 明确说"消息发到当前 offline 的 agent SHALL be persisted". 该 Requirement 的 Scenario 用的是 `sess-B` 单发, 属于 to_agent_id 路径. **本 change 不改该行为** — 单发依然 offline-delivery. 仅 role/broadcast fan-out 改行为.

为避免歧义, 新 Requirement 显式写"applies to role-based routing and broadcast ONLY; single `to_agent_id` sends remain unaffected".
