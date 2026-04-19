## Context

当前 `agent-registry` 规范 (`openspec/specs/agent-registry/spec.md:107-187`) 把 agent 身份定义为 `(team, name, role)` 三元组:

```
  register_agent({team, name, role, ...})
    └─ SELECT agent_id FROM agents WHERE team=? AND name=? AND role=?
    └─ reuse if found, else create new
```

索引是 `agents_identity_idx ON agents(team, name, role)` (非 UNIQUE, 仅加速查找).  `(team, name)` 相同但 role 不同的两次 register 会落到两行, 两个 agent_id.

现在要把身份收窄到 `(team, name)`:

```
  register_agent({team, name, role, ...})
    └─ SELECT agent_id FROM agents WHERE team=? AND name=?
    └─ reuse if found → upsert role + model + tmux_pane_id
    └─ else create new
```

索引升级为 UNIQUE on `(team, name)`, 物理阻止同 team 同 name 多行.

约束:

- **MVP fresh-boot**: 不做 migration; 新 schema 直接覆盖, 旧数据丢弃 (与 `feedback_skip_legacy_db_migration.md` 一致).  如果旧 DB 里存在 (team, name) 重名但 role 不同的多行, fresh-boot 后这些历史行丢失, 由用户重新 register — 这是显式接受的代价.
- **不保留兼容 shim**: 现行测试里 Scenario "Role change produces new agent_id (new identity)" (spec line 151-156) 被 REMOVED, 不给任何过渡期.
- **不改 collision 语义**: Requirement "Within-session agent_id_collision via Authorization header" 的触发条件 — 同一 MCP session id + 不同 Authorization — 不变. 本次只改 identity 维度.
- **role 仍是合法字段**: `agents` 表 `role` 列保留, `register_agent` 仍接受 `role` 参数, 只是 role 的值在 upsert 时会被最新调用覆盖, 不再触发新行.

## Goals / Non-Goals

**Goals:**

- G1  `(team, name)` 作为物理唯一键, 通过 UNIQUE 索引在 SQLite 层强制约束
- G2  `register_agent` 幂等: 同一人多次注册 (即使 role 变化) 始终返回同一 `agent_id`, 保留 mailbox 连续性与历史 cursor
- G3  为未来的 "名字驱动 MCP 路径" (`send_message({to_team, to_name})`, `list_agents({team?})` 等) 打基础, 使名字解析无歧义
- G4  降低 LLM 调用者的心智负担 — 不再需要额外记忆 role 才能对应到 agent

**Non-Goals:**

- NG1  本次不实现 `send_message` / `broadcast_to_role` 的 `{to_team, to_name}` 入参 — 那是独立 change
- NG2  本次不扩 `list_agents` 支持跨 team 查询 — 独立 change
- NG3  不做 DB migration, 不写 "从 (team, name, role) 合并到 (team, name)" 的脚本
- NG4  不在 SQLite 之外再加一层应用层去重逻辑 — UNIQUE 索引 + `ON CONFLICT` 足够
- NG5  不移除 `role` 列 — 它仍有信息价值 (e.g. `broadcast_to_role` 继续按 role 扇出, 只是不同 role 不代表不同身份)

## Decisions

### D1  UNIQUE 索引替代普通索引, 物理兜底

```sql
CREATE UNIQUE INDEX IF NOT EXISTS agents_identity_idx ON agents(team, name);
```

**为什么 UNIQUE?**  应用层幂等逻辑存在 TOCTOU 窗口 — `SELECT ... WHERE team=? AND name=?` 和后续 `INSERT` 之间如果有并发 register, 应用层 check 会误判. UNIQUE 索引在 SQLite 层加原子约束, `INSERT` 冲突直接返回 SqliteError, 然后转 UPSERT.

**备选 (未采纳)**: 保留普通索引 + 应用层 `SELECT FOR UPDATE` — SQLite 不支持行级锁, 而且这相当于把原子性责任放到上层, 更脆.

### D2  Upsert 使用 `INSERT ... ON CONFLICT (team, name) DO UPDATE`

```sql
INSERT INTO agents (agent_id, team, role, name, model, registered_at, last_seen_at, tmux_pane_id)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (team, name) DO UPDATE SET
  role        = excluded.role,
  model       = excluded.model,
  last_seen_at = excluded.last_seen_at,
  tmux_pane_id = COALESCE(excluded.tmux_pane_id, tmux_pane_id)
```

- `agent_id` 在 INSERT 时生成新 UUID, 但冲突分支不更新 `agent_id` — 原行的 `agent_id` 被保留 (这是 G2 的核心)
- `registered_at` 不在 UPDATE 列表里 — 原行最初的注册时间保留, 只有 `last_seen_at` 随 register 刷新
- `tmux_pane_id` 用 `COALESCE(excluded.tmux_pane_id, tmux_pane_id)` — 传入值为 NULL 时保留原值 (保持 spec 的 "omission means no change" 语义, 与 `agent-registry/spec.md:118` 一致)
- `role` / `model` 无条件覆盖 — 最新一次注册说什么就是什么

**SELECT 要用 `excluded` 还是 `agents`?**  `excluded` 是 ON CONFLICT 子句提供的虚拟表, 代表 "本次 INSERT 被拒的那一行". UPSERT 标准写法是 `SET col = excluded.col`.

**为什么不先 `SELECT ... WHERE team=? AND name=?` 再决定?**  可以那样写, 但两条语句比一条 UPSERT 多一次 round trip, 也多一个竞态窗口. ON CONFLICT 原子完成查-插-更.

### D3  `AgentsRepo.findByIdentity({ team, name })` 签名变窄

```typescript
// Before
findByIdentity(args: { team: string; name: string; role: string }): { agent_id: string } | undefined

// After
findByIdentity(args: { team: string; name: string }): { agent_id: string } | undefined
```

`role` 参数从签名里去掉, 调用方 (`register` 方法) 也跟进.  TypeScript 的类型检查会把所有误传 `role` 的点暴露出来, 编译即发现.

### D4  `RegisterAgentService.identityKey` 从三元组变二元组

```typescript
// Before
function identityKey(team: string, name: string, role: string): string {
  return `${team}\u0000${name}\u0000${role}`
}

// After
function identityKey(team: string, name: string): string {
  return `${team}\u0000${name}`
}
```

这个 key 用于 `RegisterAgentService.connections` Map, 防止同一 (identity) 被两个不同 connection_id 抢占. 收窄到二元组后, 语义变为 "同 team 同 name 被 session X 占用, session Y 再来 register 同一名字要拿到 collision 错" — 无论 Y 传的 role 是什么.

**这引入一个行为变化**: 如果 session X 注册 `(default, alice, backend)`, 然后 session Y 注册 `(default, alice, frontend)` 试图抢占, 现在会得到 `agent_id_collision` — 以前不会.  这是**预期结果**: 同 team 同名就是同一个 alice, 谁先到谁占用.

### D5  Scenario 的 ADD / MODIFIED / REMOVED

| Scenario (current name) | Action | Rationale |
|---|---|---|
| `New identity creates a fresh agent_id` | MODIFIED | 文案 "identity is (team, name, role)" 更新为 "identity is (team, name)"; 示例参数简化 |
| `Reconnect reuses existing agent_id` | MODIFIED | 同上 |
| `Reuse updates tmux_pane_id when provided` | MODIFIED | 文案对齐 |
| `Reuse preserves tmux_pane_id when omitted` | MODIFIED | 文案对齐 |
| `Role change produces new agent_id (new identity)` | **REMOVED** | 行为反转; 该场景已不存在 |
| `Team change produces new agent_id` | KEPT / MODIFIED | team 仍是身份一部分, 行为不变, 只需文案对齐 |
| `Name is required and must be non-empty` | KEPT | 独立于 identity 定义, 不变 |
| `Name after trim must be non-empty` | KEPT | 同上 |
| `Role defaults to "default" when omitted` | KEPT | role 仍是字段, 默认值逻辑不变 |
| `Team defaults to "default" when omitted` | KEPT | 同上 |
| `Same session re-registers with new tmux_pane_id` | MODIFIED | identity 定义收窄, 文案对齐 |
| `Re-register after reconnect preserves mailbox continuity` | KEPT / MODIFIED | 这个场景因 identity 收窄更强力: role 变了 mailbox 也连续 |
| (new) `Role change updates existing agent_id in-place` | **ADDED** | 取代被 REMOVED 的场景, 断言反向行为 |

## Runtime Assumptions

Runtime Assumption Audit 扫描结果:

- 设计中出现 `默认` / `保持不变` / `与 .* 一致` 措辞, 均指向**本仓库内**已有且可读代码的行为 (SQLite ON CONFLICT, 现有 collision 语义, `feedback_skip_legacy_db_migration.md` 的 fresh-boot 约定), 不涉及外部库的隐式默认.
- 使用的外部依赖 (`better-sqlite3`) 行为是标准 SQLite, UNIQUE 索引 + ON CONFLICT 是显式 SQL 语法, 不依赖默认.

### A1:  SQLite ON CONFLICT 的 DO UPDATE 语义

**Assumption**:  `INSERT ... ON CONFLICT (team, name) DO UPDATE SET ...` 在检测到 `agents_identity_idx` 唯一索引冲突时, 把 `SET` 子句里的值应用到**已存在的那一行**, 而不是新建或替换; 原行的 `agent_id` 保持不变; `SET` 子句未列出的列 (如 `agent_id`, `registered_at`) 保持原值.

**Rationale**:  这是 SQLite 3.24+ 的标准 UPSERT 语法.  `better-sqlite3` 12.0 基于 SQLite 3.47, 完整支持.  `excluded` 虚拟表指向 "本次 INSERT 试图写入但因冲突被拒的行".

**Verification**:  task 1.2 GREEN test 会验证 "同 (team, name) 再次 register, agent_id 不变, role/model 更新, registered_at 不变".

### A2:  UNIQUE 索引对 fresh-boot 空表不会报错

**Assumption**:  `CREATE UNIQUE INDEX IF NOT EXISTS agents_identity_idx ON agents(team, name)` 在空表上执行等价于创建索引; 在有数据的表上若存在 (team, name) 重名行会直接报 `UNIQUE constraint failed`.  MVP fresh-boot 保证执行时表为空, 不触发冲突.

**Rationale**:  与 `refactor-mailbox-routing` 的 A1 同理: fresh-boot 下 `applySchema` 在空 DB 上跑 DDL, 没有历史行可冲突.  `IF NOT EXISTS` 保证重复启动幂等.

**Verification**:  task 1.1 RED test 先 INSERT 两行重名再运行 `applySchema`, 预期抛 `UNIQUE constraint failed`; GREEN 后 fresh-boot 路径 (applySchema 在空表) 不抛错.

## Risks / Trade-offs

| Risk | Mitigation |
|------|-----------|
| R1  现有测试里有显式断言 "role 改变 → 新 agent_id" 的场景, 直接 REMOVED 可能遗漏 | Delta spec 显式 REMOVED 该 scenario, 测试迁移到新 ADDED scenario; grep 验证 |
| R2  旧 DB 文件在升级启动时, `CREATE UNIQUE INDEX` 会报 `UNIQUE constraint failed` 因为历史 (team, name, 不同 role) 重名行存在 | fresh-boot 约定 + migration plan 里明确 "删除旧 DB" |
| R3  `connections` Map key 变窄 → 原本 session X 注册 backend, session Y 注册同名 frontend 是合法, 现在直接 collision | 这是预期行为 (D4), 写入测试 |
| R4  `COALESCE(excluded.tmux_pane_id, tmux_pane_id)` 语义在 fresh-boot 空表 INSERT 时, `tmux_pane_id` 指向未存在的行 — 会不会报错? | 不会: ON CONFLICT 分支只在冲突时取 `excluded` 外的列值, 首次 INSERT 直接写入 `excluded.tmux_pane_id` 原值 |
| R5  Upsert SQL 复杂, 容易写错列映射 | D2 的完整 SQL 贴在 design, task 1.2 GREEN 粘贴同一份; TDD RED/GREEN 校验 |
| R6  Memory `project_p2_agent_id_reuse.md` 描述四元组 (team, tmux_pane_id, display_name, role), 措辞与实际实现 (三元组 team/name/role) 本来就不一致, 这次再变更会加深漂移 | 作为 task 5.1 的 doc-only 任务显式同步 memory 到 "(team, name) 二元组", 并注明 tmux_pane_id 从来不是 identity 的一部分 (只是被 update 的字段) |

## Migration Plan

1.  合并到 main 后, 用户在部署机停 daemon
2.  删除旧的 SQLite 数据库文件 `~/.ts-agent-teams/data.db` (+ `-shm` / `-wal` sidecars)
3.  启动新 daemon →  fresh-boot →  新 schema 生效 (UNIQUE 索引建立在空表上, 永远不冲突)
4.  重启所有关联 tmux 内的 agent, 让其重新 `register_agent` — 原先同一人多 role 分身会收敛到一行
5.  任何依赖 "backend/frontend 分身各有独立 mailbox" 的流程必须改写

**Rollback**:  git revert + 重启 daemon.  因为没有 migration, 回滚同样会丢失新 schema 下产生的数据, 属于预期行为.

## Open Questions

无.  讨论中已就以下关键点定稿:

1.  硬约束而非软约束 + 歧义回错 (User 明确选择选项 1)
2.  role 列保留, 只是身份降级 (隐含 — broadcast_to_role 还要用 role)
3.  命令行 UX 变化 (名字驱动路径) 是独立 change, 本次不混入 (User 明确分离)
4.  MVP fresh-boot, 不做 migration (项目 memory 既有约定)
