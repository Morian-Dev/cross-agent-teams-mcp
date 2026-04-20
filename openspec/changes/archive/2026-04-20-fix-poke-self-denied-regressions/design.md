## Context

`src/mcp/poke.ts:124` 当前实现:

```typescript
if (target.agent_id === deps.callerAgentId) return { error: 'self_poke_denied' }
```

`callerAgentId` 由 `src/mcp/transport.ts:37-38` 决定, 来源是当前 MCP session 在 `register_agent` 成功后写入的 `agentIdHolder.current`. 即每个 session 的 caller 身份是注册成功后服务端记下来的 canonical `agent_id`.

`target.agent_id` 来自 `SELECT ... FROM agents WHERE agent_id = ?`, 也是 canonical 主键.

两者比较等价于 "调用方所属的 agents 行 == 目标 agents 行". 这就是 self-poke 的正确定义.

任务描述里给的 "强假设根因" (guard 比对错了字段, 比如 connection id / session id / pane id) 经实际代码核对**不成立**. 真实退化路径是测试 fixture 在新身份模型 `(team, name)` 下意外让 caller 和 target 折叠到同一行 — 例如 `tests/poke-validation.test.ts:84`:

```typescript
const A = await connectClient(host, port)
const B = await connectClient(host, port)
await register(A.c, { role: 'caller' })             // name='tester-8', team=default
const targetId = await register(B.c, { role: 'target' })  // name='tester-8', team=default
```

`tighten-agent-identity` 之后, `(default, tester-8)` 是 UNIQUE 索引主键, `AgentsRepo.register` (`src/storage/agents-repo.ts:34-50`) 走 `INSERT ... ON CONFLICT (team, name) DO UPDATE`, B 的注册并不创建新行, 而是更新 A 已经写下的同一行, 然后 `SELECT agent_id WHERE team=? AND name=?` 取回的就是 A 的 `agent_id`. `targetId === A's agent_id` → poke 等于让 A 戳自己 → `self_poke_denied`.

注意 `RegisterAgentService` 的内存 `connections` Map (`src/mcp/register-agent.ts:23`) 不能阻挡这条路径: 它是 per-`registerBusinessTools` 实例, 而 `registerBusinessTools` 在 `src/mcp/transport.ts:91` 是 per-session 调用的, 所以两个 session 各自持一个空 Map, 互相看不见. 这是另一处可以收紧的地方, 但**不在本 change 范围**: 本 change 只解决 4 条挂着的失败测试 + 补足反向 spec.

约束:

- **不动 production 守卫逻辑**: `target.agent_id === deps.callerAgentId` 这条比较是规范定义的 self-poke 判定, 改它会破坏 `tests/poke-validation.test.ts:69` ("returns self_poke_denied when caller pokes itself") 这条已通过的正向 case
- **不重构 register / connection 绑定**: 上面提到的 `RegisterAgentService.connections` per-session 空 Map 问题留给后续独立 change 处理, 本 change 不扩 scope
- **不改 error taxonomy**: `self_poke_denied` 错误码本身意义不变
- **不动 MCP schema**: 入参 / 返回 shape 一律保留

## Goals / Non-Goals

**Goals:**

- G1  4 条 baseline 失败测试 (`poke-validation.test.ts:84`, `poke-tmux-unavailable.test.ts:42`, `poke-e2e.test.ts:43`, `poke-e2e.test.ts:78`) 在本 change 完成后转 GREEN
- G2  新增反向回归测试 `tests/poke-self-denied-distinct-agents.test.ts`, 显式断言 "caller.agent_id ≠ target.agent_id ⟹ NOT self_poke_denied", 即使其他维度(team / role / pane id / 同一进程)碰撞也无影响 — 把判定边界钉死在 `agent_id` 维度
- G3  `agent-interrupts/spec.md` 的 "Self-poke is rejected" Requirement 加一条 Scenario, 把这条边界写到 spec, 防止未来再 regress
- G4  `pnpm test` 全套绿 (除已知与本 change 无关的失败外, 全部修复或不引入新失败)

**Non-Goals:**

- NG1  不修改 `src/mcp/poke.ts` 守卫逻辑
- NG2  不重构 `RegisterAgentService` 的 connection 绑定 / 内存 Map / 跨 session 协调
- NG3  不改 `agent_id_collision` 错误的语义或返回时机
- NG4  不引入新的 self-poke 错误码或 detail 字段
- NG5  不修改 `target_agent_id` 的解析路径 (UUID / name) 或 poke MCP 入参 schema

## Decisions

### D1  `self_poke_denied` 的规范判定永远是 `target.agent_id === caller.agent_id`

**决策**: 保持 `src/mcp/poke.ts:124` 的现行实现不变. 任何未来代码改动 (包括其他 PR) 不得把这条比较替换成 connection_id / session_id / pane_id / `(team, name)` tuple 等任何代理身份.

**为什么**:
- `agent_id` 是 `agents` 表主键 (`UUID`), 已经唯一标识一个 agent 实体
- `(team, name)` 经 `tighten-agent-identity` 收紧后是 logical identity, 但 production 代码的所有比较 / lookup 都用 `agent_id`; 守卫沿用同一维度, 与系统其他部分一致
- 如果未来某条路径让 "同一 agent 持有两个 agent_id" (理论上 `tighten-agent-identity` 已禁止), 那是 register 路径的 bug, 不该让 self-poke 守卫去补救

**反向命题 (本 change 编入测试与 spec)**: 当 `caller.agent_id !== target.agent_id` 时, **任何**其他属性的等同 (同一 team, 同一 role, 同一 tmux_pane_id, 同一 process pid, 同一 host) 都不构成 self-poke. 守卫绝不能在这些维度上短路.

**备选 (未采纳)**: 让守卫退化为 "if target is the same row by `(team, name)` tuple". 否决: 与 `agent_id` 主键身份模型不一致, 引入双重身份比较, 反而把语义模糊化.

### D2  测试 fixture 修复策略: 给每个 client 独立 `name`

**决策**: 4 条 failing 测试中, 把 caller 和 target 用不同的 `name` 注册:

```typescript
// tests/poke-validation.test.ts:84 (示例)
await register(A.c, { name: 'tester-8-caller', role: 'caller' })
const targetId = await register(B.c, { name: 'tester-8-target', role: 'target' })
```

这要求把 `register` helper 函数签名加上 `name?: string` 可选项 (默认保留原值, 兼容旧 call site), 然后失败测试显式传不同 name.

**为什么不靠 `team` 区分?** team 不同会触发 `cross_team_denied` (`src/mcp/poke.ts:130`), 把测试想要断言的下游 error 又一次短路.

**为什么不靠 `role` 区分?** `tighten-agent-identity` 把身份从 `(team, name, role)` 收窄到 `(team, name)`, role 已经不是身份维度, 同 name 不同 role 仍然 collapse 到一行.

**为什么不靠 `tmux_pane_id` 区分?** pane id 是属性不是身份, 同 `(team, name)` 仍 collapse, 而且本就在 fixture 里被显式指定 / 不指定来构造测试场景, 不能拿来当区分维度.

### D3  Spec delta: MODIFIED Requirement, 加反向 Scenario

`openspec/specs/agent-interrupts/spec.md:76-85` 已经存在 Requirement "Self-poke is rejected" 与正向 Scenario "Caller pokes self". 本 change 用 `## MODIFIED Requirements` 复述该 Requirement (条文不变), 在其下追加新 Scenario "Distinct agents are never treated as self-poke", 把反向边界写入 spec.

**为什么是 MODIFIED 而不是 ADDED**: openspec 规则要求一个 Requirement 在 delta 与主 spec 之间必须身份对应; 已有 Requirement 不能用 ADDED 复制一遍. 加 Scenario 必须通过 MODIFIED 整条 Requirement (复写 Requirement statement + 全部 Scenarios, 包括新的) 来表达.

### D4  反向回归测试覆盖矩阵

`tests/poke-self-denied-distinct-agents.test.ts` 覆盖以下三组 (caller, target) 组合, 全部断言 NOT `self_poke_denied`:

| 场景 | caller (team/name/role/pane) | target (team/name/role/pane) | 期望非 `self_poke_denied`, 实际期望 |
|---|---|---|---|
| 完全独立两 agent | `(default, alice, dev, %1)` | `(default, bob, dev, %2)` | `ok:true` (走完 happy path; 用 vi.mock 的 tmux-cli 兜住) |
| 不同 name, 同 pane id (pane id 不应误判) | `(default, alice, dev, %42)` | `(default, bob, dev, %42)` | `ok:true` |
| 不同 name, 无 pane id | `(default, alice, dev, null)` | `(default, bob, dev, null)` | `tmux_pane_not_set` (说明流程穿过 self-poke 守卫, 进入 pane-not-set 守卫) |

测试用单元层注入 (直接 seed 两行 + 调 `poke()`), 不经 MCP transport, 避免 register 路径的副作用干扰断言.

## Runtime Assumptions

(无 — 本 change 不改任何 production 行为, 不依赖外部 default / 环境探测 / probe cache, 也不引入新的 runtime 路径; 全部变更落在测试 fixture 与 spec 文档.)

## Risks / Trade-offs

- **R1  不修守卫可能错过更深的 root cause**: 我们结论是守卫正确 + fixture 错. 反向回归测试 (D4) 是兜底 — 如果未来真有 bug 让两个不同 agent_id 被判 self-poke, 这条测试会 RED, 把 regression 拦在 CI 里.
- **R2  helper 函数签名扩展可能影响其他测试**: `register` helper 在 4 个测试文件里被复制定义, 不是共享 module. 改其中之一不会污染另外几个; 同时确保 `name?: string` 是可选参数, 不传时保留旧默认行为, 不破坏文件内其他用 helper 的 case.
- **R3  spec 追加 Scenario 会让其他 change 在 sync 时看到 "Self-poke is rejected" 的 Scenario 数量从 1 变 2**: 这是预期变化, openspec spec drift 检查会 PASS (Scenario 添加不算破坏性 modification).

## Migration Plan

N/A — production 代码无任何修改, 数据库 schema 无变化, MCP 协议无变化, 也无运行时配置变化. apply 阶段只动测试文件与一份 spec delta.
