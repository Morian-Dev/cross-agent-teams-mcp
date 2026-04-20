## Why

`tighten-agent-identity` (archived 2026-04-19) 把 `agents` 的身份键从 `(team, name, role)` 收紧到 `(team, name)`. 在那之前, 4 条多客户端 poke 测试用同一个 `name`(如 `tester-8`) 但不同 `role` 区分 caller / target, 因此两次 `register_agent` 拿到两个不同的 `agent_id`. tighten 之后, 同 `(team, name)` 上的两次 register 都被 upsert 折叠到**同一行**, A 和 B 实际上拿到同一个 `agent_id`. 接下来 `poke({target_agent_id: B's id, ...})` 因为 `target.agent_id === callerAgentId` 触发 `self_poke_denied`, 把测试想要断言的 `tmux_pane_not_set` / `tmux_unavailable` / `pane_dead` / 正常 happy-path 全部短路掉.

`src/mcp/poke.ts:124` 的守卫本身正确(`target.agent_id === deps.callerAgentId` 就是 self-poke 的规范定义). 真正的退化在测试 fixture: 跨 client 用同名注册, 在新身份模型下等价于让两个 client 同时登录同一个 agent.

运行时验证 (2026-04-20):

```
× tests/poke-validation.test.ts > returns tmux_pane_not_set when target has no tmux_pane_id
  expected { error: 'self_poke_denied' } to deeply equal { error: 'tmux_pane_not_set' }
```

影响: 4 条 baseline 失败长期挂着, 任何后续 change 的 GREEN 验证都得手工排除它们; 同时 spec 缺了一条对 "caller.agent_id ≠ target.agent_id 必须不被判 self" 的反向断言, 留出未来再次踩同一坑的可能.

## What Changes

- **测试修复**: `tests/poke-validation.test.ts:84`, `tests/poke-tmux-unavailable.test.ts:42`, `tests/poke-e2e.test.ts:43`, `tests/poke-e2e.test.ts:78` 让 caller 和 target 用不同的 `name`, 使两次 `register_agent` 真正落到两行 `agents` 行
- **回归测试新增**: `tests/poke-self-denied-distinct-agents.test.ts` 显式断言 "caller.agent_id ≠ target.agent_id 时 NOT self_poke_denied", 覆盖即使其他属性(team / pane id / role)不同也不影响判定的反向场景
- **Spec 增强**: `agent-interrupts/spec.md` 的 Requirement "Self-poke is rejected" 添加一条 Scenario "Distinct agents are never treated as self-poke", 把判定边界写死到 `agent_id` 维度
- 代码不动: `src/mcp/poke.ts:124` 维持现行 `target.agent_id === deps.callerAgentId` 比较逻辑

## Capabilities

### New Capabilities

(无全新 capability)

### Modified Capabilities

- `agent-interrupts`: 在 "Self-poke is rejected" Requirement 下补充反向 Scenario, 明确 self-poke 仅由 `agent_id` 等价决定, 不受任何其他属性影响

## Impact

- **代码**: 不修改任何 `src/` 文件 (production 守卫已正确)
- **测试**:
  - 修改: `tests/poke-validation.test.ts` (Task 1.4 fixture), `tests/poke-tmux-unavailable.test.ts` (Task 1.5 fixture), `tests/poke-e2e.test.ts` (Task 1.6 双场景 fixture)
  - 新增: `tests/poke-self-denied-distinct-agents.test.ts` (Task 2.1 反向回归断言)
- **spec**: `agent-interrupts` delta — MODIFIED Requirement "Self-poke is rejected" 加 Scenario
- **数据库**: 无 schema 变化; 无 migration
- **依赖**: 无新外部依赖
- **MCP client**: 无感知 — 协议无变化, 仅修复测试 fixture 与补足 spec 反向断言
