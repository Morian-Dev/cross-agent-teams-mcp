## Context

当前 mailbox 的对外接口是:

```
send_message({to_agent_id?, to_role?, subject?, body, auto_poke?})
  └─ 分支 1: to_agent_id   → 1→1 私聊 (同 team)
  └─ 分支 2: to_role       → 按 role 扇出 (同 team 内所有匹配 agent)

broadcast({body, subject?, auto_poke?})
  └─ 同 team 全员 (除自己)
```

两个问题:

1.  **语义混叠**:  `send_message({to_role})` 本质上是"带角色筛选的广播", 却挂在"send message"这个名字下.  对调用方 (另一个 agent 或人类) 而言, 看到 `send_message` 很容易默认这是"发给一个人", 从而在不经意间做出多人扇出, 尤其是 LLM prompt 中的 "send a message to the frontend" 这类表达会被模型自然地翻译成 `send_message({to_role: 'frontend'})`, 放大一个人到一群人.
2.  **硬 team 边界**:  两个接口都在 SQL 层硬编码 `WHERE team = fromRow.team`, 用户即使明确需要向另一个 team 的特定 agent 发送信息 (跨团代码评审, 跨团事件协调) 也做不到.

本次重构要:

- 把 `send_message` 收窄到 1→1 私聊
- 把 role 扇出迁出到新的独立工具 `broadcast_to_role`
- 让 `send_message` 支持 `to_team` 参数, 允许用户**显式**发起跨 team 私聊
- 数据库层为 `messages` / `events` 引入 `from_team` + `to_team` 对称字段

约束:

- **MVP fresh-boot**:  不做 DB migration, 新 schema 直接覆盖, 旧数据丢弃 (与项目 memory `feedback_skip_legacy_db_migration.md` 一致).
- **不加兼容 shim**:  `send_message({to_role})` 调用在新版本应立即报 schema 错误 (MCP tool 层 Zod 验证层就会挡住, 不需要运行时特判).
- **不改 auto-poke / retry 机制**:  `send_message`/`broadcast`/`broadcast_to_role` 三者共用 auto-poke fan-out 与 retry-backoff 逻辑, 只是 recipient 集合的计算方式不同.
- **SSE 不投递 message 事件**:  消息送达依赖 `messages` 表持久化 + `get_inbox` 轮询 + auto-poke, 从未依赖 SSE.  SSE 仅推 `contract_event`.  跨 team 消息不改 SSE 语义.

## Goals / Non-Goals

**Goals:**

- G1  `send_message` 接口收敛为 1→1 私聊, 移除 `to_role` 参数
- G2  新增 `broadcast_to_role` 工具, 承载原先 `send_message({to_role})` 的语义
- G3  `send_message` 支持显式 `to_team` 参数以发起跨 team 私聊
- G4  `messages` 与 `events` 表引入对称的 `from_team` + `to_team` 字段, 语义上同 team 事件 `from_team == to_team`
- G5  工具描述在协议层传达 "除非用户明确指定, 不要跨 team" 的约束
- G6  跨 team 私聊仍触发 auto-poke (只要 recipient 有 `tmux_pane_id`), 保持行为一致

**Non-Goals:**

- NG1  跨 team 的 role 扇出:  `broadcast_to_role` 永远 team-scoped, 不接受 `to_team`, 没有"跨 team 某 role"
- NG2  全局广播:  `broadcast` 保持 team-scoped, 不引入 "all teams" 变种
- NG3  运行时权限 / 确认机制:  跨 team 不加 `cross_team:true` 类特殊参数, 也不弹 human-in-the-loop 确认; 调用方 (LLM agent) 看到用户的自然语言"发给 team-beta 的 xx"时, 直接翻译为 `to_team` 参数
- NG4  DB migration:  不写 legacy schema → new schema 的迁移脚本
- NG5  `send_message({to_role})` 的向后兼容 shim
- NG6  跨 team SSE 事件推送 (当前 SSE 只服务 contract_event, 消息不走 SSE, 这次不变更)
- NG7  `events.payload` 内冗余记录 `to_team` (字段已独立存在, 不在 payload 里重复)

## Decisions

### D1  三工具分立, 职责不重叠

```
  send_message        → 必填 to_agent_id, 可选 to_team;  1→1 私聊
  broadcast           → 无 to_*, 同 team 全员;  自动扇出
  broadcast_to_role   → 必填 to_role, 无 to_team;  同 team role 扇出
```

**为什么不合并成一个多态 tool?**  MCP tool 的描述是给 LLM agent 看的, 更窄的工具名能更准确地约束 agent 行为.  `send_message` 要么 1→1, 要么不是 `send_message` —  这种约束用三个独立名字表达最清晰.

**备选方案 (未采纳)**:  保留单一 `send_message({to_agent_id|to_role|broadcast:true})` 多态接口.  被否决理由: LLM 容易把"通知团队 X 关于 Y"翻译成 `to_role: 'X', body: Y`, 放大 blast radius; 三工具分立后, agent 必须显式选择 "broadcast_to_role" 这个名字, 提示它"这是一次群发".

### D2  跨 team 通过 `to_team` 参数触发, 无特殊标志位

```
  send_message({to_agent_id: 'sess-B'})                    → 同 team 私聊
  send_message({to_agent_id: 'sess-B', to_team: 'alpha'})  → 如果 from_team='alpha' 仍同 team (幂等)
                                                            → 如果 from_team≠'alpha' 跨 team 私聊
```

**为什么不用 `cross_team:true`?**  冗余.  `to_team == from_team` 时行为与省略一致, 用户显式写 `to_team` 就已经表达了"我知道我在指定 team".  加 `cross_team:true` 只会让接口表面积变大.

**LLM 行为约束通过 tool description 实现**: `send_message` 描述里写 "除非用户明确指定 `to_team`, 不要跨 team 沟通".  依靠 agent 的对齐, 不靠代码拦截.

### D3  `agent_id` 视为全局唯一主键, 跨 team 查找直接用主键

```
  src/storage/schema.ts:14  agent_id TEXT PRIMARY KEY   ← 已存在
```

跨 team 私聊时, SQL 由 `WHERE agent_id=? AND team=?` 改为 `WHERE agent_id=?` 后校验 recipient.team 是否等于输入的 `to_team`.  若不等 → `unknown_recipient`.

**为什么不复合键?**  `agents` 表已经用 `agent_id` 作 PK, 且 `register_agent` 幂等规则保证每个 (team, tmux_pane_id, display_name, role) 四元组对应唯一 agent_id.  重复 id 不可能出现, 不需要 `(team, agent_id)` 复合键.

### D4  `messages` 和 `events` 都用 from_team + to_team, 不共享"team"字段

```
  messages: from_team, to_team     + from_agent_id, to_agent_id, to_role
  events:   from_team, to_team     + actor_agent_id
```

**为什么 events 也拆?**  对称一致性.  查询"我 team 收到了哪些事件"和"我 team 发起了哪些事件"是两个独立维度, 不能共享一个字段.  虽然 99% 事件 `from_team == to_team`, 但强制对称让 schema 对跨 team 消息天然友好, 不需要再在 payload 里塞字段.

**索引**:

```sql
  CREATE INDEX idx_events_from_team_eventid ON events(from_team, event_id);
  CREATE INDEX idx_events_to_team_eventid   ON events(to_team, event_id);
```

两个都建, SQLite 索引成本低, 不必抠.  原 `idx_events_team_eventid` 删除.

### D5  SSE fanout 过滤键改为 `event.to_team`

`sse-fanout.ts:69`:

```diff
- if (session.team !== event.team) continue
+ if (session.team !== event.to_team) continue
```

**理由**: SSE 推送的是"投递给接收方 team 的事件".  对于当前只推的 `contract_event`, `from_team == to_team`, 两种过滤等价;  为未来预留 (如果将来要推 message 事件给跨 team 接收方), `to_team` 是正确的方向.

### D6  `broadcast` 语义完全不变, 只改 schema 字段名

`broadcast` 的 recipient 集合算法 (同 team 除自己, 且 last_seen_at > 在线阈值) 保持不变.  唯一改动是写入 `messages` / `events` 时, `from_team = to_team = caller.team`.  tool description 里加一句 "如需跨 team 私聊请用 send_message({to_team})", 用于引导 LLM.

### D7  `get_inbox` 的团队边界:  接收方视角

```
  SELECT * FROM messages
  WHERE to_agent_id = :caller AND to_team = :caller.team
    AND event_id > :since_event_id
```

**为什么加 `to_team` 过滤?**  收件箱是"我作为 agent 在我所属 team 收到的消息".  跨 team 发给我的消息, `to_team` 写我 team, `from_team` 写发送方 team, 天然满足条件.  不需要额外分支.

### D8  Auto-poke 跨 team 行为

跨 team `send_message` 走同一条 `fanoutAutoPoke` 路径:

- 用 `to_agent_id` 查全 DB 的 `agents` 表 (不加 team 过滤, 因为已经验证过 to_team 匹配)
- 取 `tmux_pane_id` 后注入 poke 提醒
- poke 提醒的 sender_identifier 仍取 `from_agent_id` 对应的 `display_name`, 与同 team 一致

**为什么不加跨 team 权限判断?**  MVP 阶段假设:  一个 daemon 进程管多个 team 的 agent, tmux pane 都在同一台机器上同一个用户下, 所有 agent 互相信任.  权限 / 隔离留给未来的多租户版本.

## Runtime Assumptions

Runtime Assumption Audit 扫描结果:

- 设计文档中出现 `默认` / `保持不变` / `与 send_message 一致` 等措辞, 均指向**本仓库内**已有且可读代码的行为 (auto-poke fanout, retry-backoff, SSE fanout), 不涉及外部库的隐式默认.
- 使用的外部依赖 (`better-sqlite3`, `fastify`) 仅作为基础设施, 本次变更不引入任何依赖其默认行为的新路径 — schema / 索引 / 查询都是显式 SQL, SSE 过滤是显式 JS 条件.

### A1:  SQLite 对新增 NOT NULL 列的行为

**Assumption**:  `from_team` / `to_team` 在 fresh-boot 的 CREATE TABLE 中声明为 NOT NULL, 插入时必须显式提供; 不存在"老数据行 NULL"的问题.

**Rationale**:  MVP fresh-boot, 不做 migration, DB 每次从空表开始.  在首次插入前, 没有"列已存在但值为 NULL"的行.

**Verification**:  task 2.1 schema RED 测试会在 fresh-boot 下 INSERT 一条不含 `from_team` 的行, 期望抛出 `SqliteError: NOT NULL constraint failed`, 验证约束生效.

### A2:  agent_id 在 `agents` 表中全局唯一

**Assumption**:  跨 team 私聊时, `SELECT ... FROM agents WHERE agent_id=?` 最多返回一行.

**Rationale**:  `agents` schema (`src/storage/schema.ts:14`) 已将 `agent_id` 声明为 PRIMARY KEY.  `register_agent` 的幂等规则 (memory `project_p2_agent_id_reuse.md`) 保证同一机器上重复注册不会产生新 id.

**Verification**:  task 3.3 跨 team 正向测试已经隐含这一点 (只查到一行且 team 字段匹配).  不需单独测试.

## Risks / Trade-offs

| Risk | Mitigation |
|------|-----------|
| R1 现有 20+ 测试引用 `messages.team` / `events.team`, 批量替换易遗漏 | 替换后跑全量测试套件 + grep `'\btable\b'` 二次校验 |
| R2 `send_message({to_role})` 被移除后, 正在运行的 agent 若携带旧 prompt 会直接报 schema 错 | 迁移文档里写清 "请统一改用 `broadcast_to_role`"; LLM 端看到错误会自然回退 |
| R3 跨 team 私聊无权限控制, 未来引入多租户时会再次改接口 | 接受.  MVP 单用户 / 单机前提下, 任意 team 互相信任, 显式 `to_team` 已是最强的意图证明 |
| R4 events 表两个索引额外占存储 | 接受.  事件量级 MVP 阶段远不会到索引成本成为问题的规模, 对称设计优先于空间 |
| R5 SSE 过滤键从 `event.team` 改 `event.to_team`, 若有遗漏的 fanout 路径不改则 contract_event 不推送 | `grep 'event.team' src/` 确认无遗留; SSE 集成测试覆盖 |
| R6 `send_message` 幂等性未改变, 但 `to_team` 参数可能被 LLM 误填 (填成一个不存在的 team), 返回 `unknown_recipient` | 现有 `unknown_recipient` 语义已覆盖此场景; 无需新增错误码 |
| R7 跨 team 私聊走 `from_agent_id` 的 display_name 生成 poke 提醒, 若发送方未注册 display_name 会落到 `agent_id[:8]` fallback | 已由现有 "Auto-poke prompt is a wake-up hint" requirement 覆盖, 行为一致 |

## Migration Plan

1.  合并到 main 后, 用户在部署机停 daemon
2.  删除旧的 SQLite 数据库文件 (例如 `~/.agent-teams-mcp/daemon.db`)
3.  启动新 daemon →  fresh-boot →  新 schema 生效
4.  重启所有关联 tmux 内的 agent, 让其重新 `register_agent` 并拉取新 tool 列表
5.  任何人工 / 脚本化的 `send_message({to_role: ...})` 改为 `broadcast_to_role({to_role: ...})`
6.  跨 team 沟通需求发生时, 用户在自然语言里明确 "发给 team-X 的 agent-Y",  agent 翻译为 `send_message({to_agent_id, to_team})`

**Rollback**:  git revert + 重启 daemon.  因为没有 migration, 回滚同样会丢失新 schema 下产生的数据, 属于预期行为.

## Open Questions

无.  Explore 阶段已就以下关键点定稿:

1.  broadcast 保持不变, role 扇出迁移到独立工具 (User 决定)
2.  跨 team 用 to_team 参数, 不加特殊标志 (User 决定)
3.  跨 team 不支持 role 扇出 (User 决定)
4.  跨 team 触发 auto-poke (User 决定)
5.  events 表采用对称 from_team + to_team 设计, 两个索引 (User 决定)
6.  SSE 过滤键用 to_team (User 决定)
