## Context

当前 MCP 架构把 `agent_id` 硬绑定到 MCP session id (每连接一次 `randomUUID()`). 后果:

- 重连即新 agent. agents 表 row 永久累积为 ghost.
- `broadcast` / `send_message(to_role)` fan-out 把 ghost 当活人, 触发 guard/retry 噪音 (P0 已 filter offline, 止血).
- `list_agents` 返回 30+ 列 stale row 难以肉眼定位活 agent.

P2 从源头修: register_agent 幂等, 同一身份重连复用 agent_id.

## Goals / Non-Goals

**Goals**:

- register_agent 按 3 元组 `(team, name, role)` 幂等; 命中 → 复用 agent_id, 更新 `tmux_pane_id`/`model`/`last_seen_at`; 未命中 → 新建.
- `name` 成为 required 字段, `display_name` 字段名被取消 (输入输出层面都叫 `name`).
- `role` 可缺省, 默认 `"default"` (和 `team` 对齐).
- transport 层 session_id 和 agent_id 解耦: 在 register_agent 成功前, 该 session 无 agent_id, 任何业务 tool 调用必须先注册.
- SSE fanout 延后到 register 后按 agent_id attach; 同 agent_id 第二次 attach 先 detach 旧 sink.

**Non-Goals**:

- 不做 legacy DB migration (按 MVP 一贯约定).
- 不做 Authorization 校验 (本项目无真 auth).
- 不改 mailbox/broadcast/send_message 的业务逻辑.
- 不做 P1 背景 GC.
- 不引入"同 pane 的幽灵清理"逻辑 (pane 不参与识别, 自然不会有 "same-pane ghost").

## Decisions

### Decision 1: 身份键 = `(team, name, role)` 3 元组

**选择**: team + name + role 三字段做 composite identity. `tmux_pane_id` **不参与**识别.

**理由**:

- Pane 变化是物理层事件 (tmux 新窗口/重启 session). 同一"人/agent"可能搬 pane, 但仍是同一身份.
- 让 tmux_pane_id 参与识别会导致 "pane 换了 → 新 agent_id → 消息丢/ghost 回来". 违反设计目标.
- team + role 作为团队结构, name 作为人格标识. 三者共同唯一足够表达 "团队里的某个角色的某个人".

**替代被驳回**:

- 4 元组含 pane: 见上, pane 变化破坏稳定性.
- 2 元组 (team + name): role 变化(同名换岗位)会混.
- 5 元组含 model: model 会升级, 不该触发新身份.

### Decision 2: `name` required + 重命名

**选择**: `display_name` 字段名改为 `name`; 输入 schema 强制 `z.string().min(1)`.

**理由**:

- 字段语义就是"人怎么称呼这个 agent", "display_" 前缀是 implementation noise. 去掉更贴切.
- 作为身份键必须非空非 null. 没名字的 agent 不知道发给谁, UX 灾难.
- role 和 team 有合理默认 ("default"), name 没有合理默认 — 每个 agent 应该有独立的名字.

**替代被驳回**:

- 保留 `display_name` 并只做 required 约束: 不贴合语义.
- 用 auto-generated name fallback (如 `agent-${randomUUID().slice(0,8)}`): 违反"required"本意, 且调用方还是得手动保存才能下次复用.

### Decision 3: 跨 session 纯幂等, 无 auth 校验

**选择**: 同 3 元组的 register_agent, 不论 authHash 如何, 都复用 agent_id.

**理由**:

- Authorization 头在本项目 MVP 阶段只是软字符串, 没有签名验证. 做 "same auth" 校验是假安全.
- 用户明确表态 "暂时注册都是我手工进行的, 本地开发用".
- 现有同 session 内的 `sessionOwners` (authHash pinning) 保留, 仍保护 "同 session 被不同 http 调用者抢".

**替代被驳回**: 跨 session 校验 auth → 增加复杂度, 没有真 auth 做支撑, 只是假性能 defense.

### Decision 4: fanout attach 延后到 register

**选择**: `fanout.attach` 从 `onsessioninitialized` 挪到 register_agent handler 成功返回前.

**理由**:

- register 前 session 无身份, emit 给它也没意义 (业务 tool 必须先 register).
- register 后才知道最终 agent_id, 这是唯一可靠的 fanout key.
- 同 agent_id 再次 attach 时的"detach 旧"语义自然处理"重连"场景: 新 session 接管 emit 路由, 旧 session 的 SSE 流不再收到事件.

**语义细节**:

- 同 session 内多次 register (换 role 等): agent_id 变, fanout 也相应 detach 旧 agent_id 的挂载, attach 新 agent_id.
- session 断开 (onclose) 时 detach 当前挂载的 agent_id. 若未 register 过, detach 空操作.

**替代被驳回**:

- 保留 attach-on-init + emit-by-agent_id-indirection map: 两层 id 并存, 长期维护心智负担大.

### Decision 5: DB schema rename + NOT NULL, 无 migration

**选择**:

```sql
-- 旧: display_name TEXT
-- 新: name TEXT NOT NULL
```

Bootstrap SQL 改为 `name TEXT NOT NULL`. 不写 ALTER 脚本.

**理由**:

- `feedback_skip_legacy_db_migration` 记忆: 本项目 MVP 阶段不做 legacy migration.
- 用户本机手工重建 DB 即可. CI/测试每次 `:memory:` fresh.

**替代被驳回**: ALTER TABLE + backfill — 冗余工作, YAGNI.

### Decision 6: agents 表 composite index on (team, name, role)

**选择**: 加 `CREATE INDEX IF NOT EXISTS agents_identity_idx ON agents(team, name, role)`.

**理由**:

- register 每次都走这个 SELECT, 百级行数也该 O(log n) 而非 scan.
- composite index 足够覆盖 3 字段 equality 查.

**替代被驳回**: 无索引 (百级下差别可忽略, 但为长期做准备).

### Decision 7: `role` 默认值 `"default"`

**选择**: input schema 允许省略 role, handler 里 fallback `"default"`.

**理由**:

- 和 `team` 的默认对齐.
- 很多一次性脚本/测试不关心 role, 逼它们提供没意义.
- 默认值是 `"default"` 而非 `null`/空字符串, 避免 NULL 参与 identity 比较的语义问题.

**替代被驳回**: 保持 role required — 与 team 不对称, 用户体验差.

## Risks / Trade-offs

- **Risk 1**: 已有测试大量使用 `display_name`, 需批量改名. 工作量大但机械.
  - **缓解**: tasks 里明确列出所有文件; RED 验证只跑新测试避免噪音; 最终全量 vitest 作为 green gate.

- **Risk 2**: `role` 变更 (同名换岗位) 会产生新 agent_id + orphan row (旧 role 的).
  - **缓解**: 这是"身份真的变了", 语义正确 — 新身份新 mailbox. 旧 role 的 row 变成 orphan, 但数量可控 (人工换 role 很少见).
  - **未来**: 如果观察到 orphan 积累, 做小范围 cleanup (不引入 P1 GC 架构).

- **Risk 3**: SSE fanout re-key 在并发 register (同 3 元组) 下可能短暂错挂. 例如 session A 正在 emit, session B 同时 register 触发 detach A.
  - **缓解**: register 是同步 SQL + 同步 fanout 操作, Node.js 单线程, 不存在真正并发竞争.
  - **缓解**: 测试补一个"两次 register 先后顺序"的用例.

- **Risk 4**: transport.ts 的 spoof 检查从 `session.sessionId` 改为 `agentIdHolder.current`. 若 agentIdHolder 未初始化 (register 前业务调用), 检查对象是 undefined, 行为与之前"sid 必匹配"不同.
  - **缓解**: register 前任何业务 tool 调用都拒绝 (现有约束不变); spoof 检查逻辑需同步调整. tasks 里有对应测试.

- **Risk 5**: 历史 agents 表 row 含 NULL `display_name`, 改 column 后 NOT NULL 约束不允许. 按 fresh-boot 假设不处理.
  - **缓解**: 文档里提一句 "旧库请 drop 重建".

## Migration Plan

1. 代码合并后 `rm daemon.db` (或用户自己选择文件路径).
2. 重启 daemon → fresh DB 生成.
3. 所有 agent 用新 schema 注册 (Claude Code / opencode / codex 配置里 `name` 字段必须有值).
4. 预期观察:
   - `list_agents` 不再出现同名 ghost 堆积.
   - `broadcast` `recipients` 稳定在团队实际人数.
   - 重连后 mailbox 内容仍可见 (agent_id 不变).

## Open Questions

(无)
