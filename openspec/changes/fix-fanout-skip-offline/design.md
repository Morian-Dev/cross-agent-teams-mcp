## Context

`agent_id = MCP session id` 的架构让每次客户端重连都登记新 agent_id; 旧 row 无 TTL 永不消失. 真实使用场景累积到 30+ ghost 后, 按 role 或 broadcast 的 fan-out 把死 session 当活人拉进来, 触发 N 次 quiet-guard 和 N 条 mailbox 写入, 2s × 并发等待 + 无意义 retry 排程.

当前已有 online 判定逻辑: `AgentsRepo.list()` 在返回时根据 `last_seen_at` 和 `ONLINE_MS = 5 * 60 * 1000` 常量 (`src/storage/agents-repo.ts:22`) 动态计算 `online` 字段; `touch()` 在每次 MCP 调用后刷新 `last_seen_at` (`src/mcp/tools.ts:76-82` `touchIfRegistered`). 阈值和刷新机制现成, 只是 fan-out SQL 没利用.

## Goals / Non-Goals

**Goals**:

- broadcast / send_message to_role 的 recipient SELECT 加入 online 过滤, 5 min 阈值.
- 单发 send_message({to_agent_id}) 行为**完全不变** — 精确寻址不过滤, 保持 offline-delivery 契约.
- list_agents 行为不变 — 仍返回全部, 带 `online` 字段, 便于诊断 ghost.
- ONLINE_MS 从 AgentsRepo 导出或挪到独立常量模块, 避免重复魔数.
- 单元测试覆盖 3 个关键场景: broadcast 混合 online/offline, to_role 全 offline, to_agent_id 不受影响.
- mailbox spec 加新 Requirement, 明文写清楚"fan-out 跳, 单发不跳".

**Non-Goals**:

- 不 GC ghost row (交给 P1 `add-agent-registry-gc`).
- 不复用 agent_id (交给 P2 `agent-id-reuse-by-idempotency`).
- 不改变 online 阈值 (5 min 沿用).
- 不加 `include_offline` 参数到 broadcast/send_message (调用方不需要"给死 agent 发消息"的显式开关; to_agent_id 单发已覆盖).
- 不改 list_agents (调用方仍能看到所有 ghost 以便排查).
- 不改 retry-backoff 逻辑.

## Decisions

### Decision 1: 过滤粒度 — SQL WHERE vs JS 过滤

**选择**: SQL WHERE `last_seen_at > ?`, cutoff 参数在 JS 中计算 (ISO 字符串).

**理由**:
- `last_seen_at` 是 ISO-8601 UTC 字符串 (`.toISOString()` 产出, 形如 `2026-04-18T19:25:00.000Z`), **字典序**等同时间序 — SQLite 字符串比较安全.
- JS 侧计算 cutoff = `new Date(Date.now() - ONLINE_MS).toISOString()`, 同格式可直接比较.
- SQL 层过滤避免先拉全部再 JS filter 的内存浪费 (当前百级 agent 其实无所谓, 但习惯上在数据源层过滤更干净).
- 不用 SQLite `datetime('now', '-5 minutes')` — 它返回的字符串格式 (`YYYY-MM-DD HH:MM:SS`, 无 `T`/`Z`/ms) 跟 `last_seen_at` 不一致, 比较会 unexpected fail.

**替代被驳回**:
- JS 端 filter: 需要先 SELECT 全部, 扫一遍再过滤, 行数多时浪费.
- SQLite datetime 函数: 格式不一致风险.

### Decision 2: 单发 to_agent_id 不过滤

**选择**: `send_message({to_agent_id: X})` 不论 X 是否 online 都按原行为走 — 落盘 mailbox + 尝试 auto-poke (guard pass/fail 由 pane 活动决定, 与 online 无关).

**理由**:
- 单发是精确寻址, 调用方清楚目标是谁. 即便当前 offline, Mailbox 的 offline-delivery 契约保证"它重连后 get_inbox 能读到".
- 反之若单发也过滤 offline, 调用方必须先 `list_agents` 自己判活, 增加 round-trip. 语义退化.
- 现有 `Offline delivery via events outbox` Scenario 明确走 `sess-B` 单发; 本 change 不动该路径.

**替代被驳回**: 单发也过滤 — 破坏现有契约, 违反最小改动原则.

### Decision 3: role 全 offline 时返回 `unknown_recipient`

**选择**: `send_message({to_role: 'frontend'})` 若 frontend role 下**所有** agent 都 offline, 返回 `{ error: "unknown_recipient" }`.

**理由**:
- 语义上"发给 frontend 角色 = 发给当前在线的 frontend 群". 若没人在线, 等价于"没匹配到", 复用 `unknown_recipient` 错误类型, 不引入新错误.
- 当前代码 `if (rows.length === 0) return { error: 'unknown_recipient' }` 已经处理"role 拼错/该 role 无人注册"的情况. 本 change 把"全 offline"也归入此桶, 调用方可以 retry 或等.
- 不引入 `no_online_recipient` 等新错误 — YAGNI, 调用方不需要区分"从没注册"和"都 offline". 若未来真要区分, 再加字段.

**替代被驳回**:
- 新错误 `no_online_recipient`: 目前无调用方需要区分.
- 把 offline recipients 也列入 `recipients: []` 返回 poked=false: 违反"fan-out 跳过 ghost"的基本目的.

### Decision 4: broadcast 全 offline 也返回 `unknown_recipient`

**选择**: 沿用现有"broadcast excludes sender"Requirement 的错误语义 — 若排除 sender 后 team 内无其他 online agent, 返回 `{ error: "unknown_recipient" }`.

**理由**: 与 Decision 3 对称. broadcast 本质是"给团队里其他所有 online 人发", 若没人返回错误. 若 sender 独自在 team (新 team 初期), 也会返回同错误, 语义一致.

### Decision 5: ONLINE_MS 常量导出位置

**选择**: `AgentsRepo.ONLINE_MS` 改为模块级 `export const ONLINE_MS = 5 * 60 * 1000` 在 `src/storage/agents-repo.ts` 文件顶部 (与 class 并排, 仍在该文件导出). `broadcast.ts` 和 `send-message.ts` 用 `import { ONLINE_MS }`.

**理由**:
- 已是文件里的顶级常量, 改 export 一字之变.
- 放到独立 `src/storage/online-threshold.ts` 过度工程. 该常量语义属于 agents-repo.

**替代被驳回**: 新建 `online-threshold.ts` — YAGNI.

### Decision 6: 阈值保持 5 分钟, 不引入 ENV override

**选择**: 5 min 硬编码. 不加 `ONLINE_TTL_MS` env 变量.

**理由**:
- 5 min 对应 MCP reconnect 的粗略周期 (若 agent 断 5 min 以上, 它的 session 大概率已经被端关了).
- 加 ENV 会带来"测试环境设短 = 假 ghost"诸如此类认知负担. 未来若发现 5 min 不合适, 再引入.
- 已有 `ONLINE_MS` 单一出口, 未来改数只改这一处.

**替代被驳回**: 加 ENV — 无明确需求.

## Risks / Trade-offs

- **Risk 1**: 真正 idle > 5 min 的 live agent 会被跳过. 当前架构下 agent 只要 last_seen_at 在 5 min 内就算 online, `touchIfRegistered` 在每次 MCP 调用时刷新. 因此 live agent 只要定期 list_agents / get_inbox / 任何 tool 就会一直 online. 除非 agent 真的 "idle > 5 min 不做任何调用"(不太可能, Claude Code / opencode / codex 都有心跳行为).
  - **缓解**: 若未来观察到真实 live agent 被误过滤, 引入 keepalive pulse 或调大阈值.

- **Risk 2**: 测试/集成场景: `tests/send-role-broadcast.test.ts` 等可能在 register 完没 touch 就直接 send, last_seen_at 等于 registered_at, **当前测试假设**"刚 register 就算 online". Online 过滤后仍然成立 (刚 register last_seen_at 是 now, 5 min 内), 理论无影响. 但若测试跨 fake timer 推进 > 5 min, 需要 touch 一下. 已在 tasks 里留位置修这个.

- **Risk 3**: `broadcast` / `to_role` 可能偶尔返回 `unknown_recipient` 而之前返回 recipients (全是 ghost). 调用方看到错误应理解为 "暂无可达目标", 建议重试或改成 to_agent_id. 这是正确的语义强化.

- **Risk 4**: 新行为与 `Offline delivery via events outbox` Requirement 的字面读法可能冲突 — 该 Requirement 用 sess-B 单发作 Scenario, 文字上只覆盖单发; 但读者可能理解为"任何 offline 都 persist". 通过在本 change 的新 Requirement 显式写 "applies to role-based routing and broadcast ONLY; single `to_agent_id` sends remain unaffected" 消歧.

## Migration Plan

1. 代码合并后 `pnpm run build` 重建 dist.
2. 重启 daemon.
3. 预期观察: 下次 broadcast 的 `recipients` 数组从 28 骤降到 ~3 (只包含最近 5 分钟活跃的 agent). retry 噪音消失.
4. list_agents 仍显示所有 30+ row 以便排查. 待 P1 GC 落地后会逐步清理.
5. 与其他 change 无 archive 顺序依赖, 随时 archive.

## Open Questions

(无)
