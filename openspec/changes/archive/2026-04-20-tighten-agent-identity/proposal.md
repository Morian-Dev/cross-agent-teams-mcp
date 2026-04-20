## Why

当前 agent 身份键是 `(team, name, role)` 三元组.  `agent-registry` spec 显式定义 "同 team 同 name 不同 role" 是两个独立身份, 可以共存.  这带来两个 UX 摩擦:

1.  用户通常用 (team, agent_name) 描述 agent ("system team 的 researcher"), 不记得也不关心 role — 但 API 层无法直接用 (team, name) 解析, 因为 (team, name) 理论上可能指向多个 agent.  跨 team `send_message` 只接受 agent_id (UUID), 人类无法手工构造, 要先去 `list_agents` 查, 而 `list_agents` 又只看自己 team — 死循环.
2.  同一人在同一 team 换角色是常态 (e.g. alice 从 backend 变 frontend), 现行规则会产生两行 agents, 两个 agent_id, 两份 mailbox 光标, 造成历史连续性断裂.

把身份键收窄到 `(team, name)` 解决这两点: 名字在 team 内唯一, (team, name) → agent_id 是确定映射, 未来可以在此基础上加名字驱动的 MCP 路径 (本次不做).

## What Changes

- **BREAKING** `agents_identity_idx` 从 `(team, name, role)` 改为 UNIQUE on `(team, name)`
- **BREAKING** `register_agent` 幂等键: 相同 `(team, name)` 的 re-register 复用 `agent_id`, role / model / tmux_pane_id 以最新一次调用为准 (upsert).  不再为 "同 name 不同 role" 创建新 agent_id
- **BREAKING** `AgentsRepo.findByIdentity` 签名去掉 `role` 参数, 变为 `{ team, name }`
- **BREAKING** `RegisterAgentService.identityKey` 内部三元组 key 收窄为二元组 `(team, name)`
- 现有 Scenario "Role change produces new agent_id" 被 REMOVED, 替换为 "Role change updates existing agent_id in-place"
- `role` 列仍然保留, 只是降级为信息性元数据, 不参与身份解析
- 跨连接冲突语义不变: 同 `(team, name)` 不同 connection_id 仍返回 `agent_id_collision` (见 Requirement "Within-session agent_id_collision via Authorization header")

## Capabilities

### New Capabilities

(无全新 capability)

### Modified Capabilities

- `agent-registry`: 身份键收窄到 `(team, name)`, Requirement "register_agent reuses agent_id by (team, name, role) identity" 措辞与 scenarios 对应调整; Requirement "Repeated register_agent for same identity updates metadata" 的 "identity" 含义改变; REMOVE "Role change produces new agent_id" scenario, ADD "Role change updates existing agent_id in-place" scenario; schema index 改名并变窄

## Impact

- **代码**: `src/storage/schema.ts` (index definition), `src/storage/agents-repo.ts` (`findByIdentity`, `register` upsert 逻辑), `src/mcp/register-agent.ts` (`identityKey`, 连接绑定的 Map key)
- **测试**: `tests/agents-schema.test.ts` (index 列断言), `tests/agents-repo.test.ts` (findByIdentity 签名, 幂等场景), `tests/agent-id-collision.test.ts` / `tests/agent-id-collision-auth-hash.test.ts` (collision 触发条件)
- **spec**: `agent-registry/spec.md` 需 delta
- **数据库**: MVP 阶段 fresh-boot, 不做 migration — 下次启动直接采用新 schema, 旧数据丢弃 (与 `feedback_skip_legacy_db_migration.md` 一致)
- **memory**: `project_p2_agent_id_reuse.md` 需同步更新 "四元组" / "三元组" 措辞 → "(team, name) 二元组"
- **依赖**: 无新外部依赖
- **MCP client**: 已部署的 agent 重启后, 同一人多 role 的旧状态会收敛到一行; 任何依赖 "我为 (team, alice, backend) 拿到 X, 再以 (team, alice, frontend) 拿到 Y" 的流程必须改写
