## Why

`refactor-mailbox-routing` 把 cross-team `send_message` 定为正式路径, spec 明确规定 "Cross-team auto-poke fires when recipient pane idle". 但底层 `poke()` 函数 (`src/mcp/poke.ts:94`) 仍然硬编码一条 `cross_team_denied` 短路 — 源自更早的 `add-poke-mcp-tool` change, 当时 poke 还接受任意 prompt, 跨 team 拦截是为了防内容泄露. 两条 spec 现在直接冲突, 运行时表现为:

```
send_message({to_team:'system', ...})
  → fanoutAutoPoke → createAutoPokeImpl → poke()
  → poke.ts:94 cross_team_denied
  → createAutoPokeImpl (tools.ts:85) 把未识别 error 映射为 guard_failed
  → send_message 响应 poked:false, retry 无限循环同样失败
```

运行时验证路径 (2026-04-19): `opus-routing (mailbox-qa)` 向 `researcher (system)` 发了 3 条消息, 全部 `poke_skip_reason=guard_failed`, 但 pane 外部 capture 字节一致, quiet-guard 本身没问题 — 是 `poke()` 的 cross-team 硬拦截被错误分类.

问题核心: 原 `cross_team_denied` 针对的是 "用户显式调 `poke` MCP tool 带任意 prompt 发给别 team". 而 `refactor-mailbox-routing` 引入的 "内部 auto-poke" prompt 是固定的 hint 格式 (`新邮件 from X, 请调 get_inbox 查看`, 不含消息 body), 没有泄露风险.  应区分这两条路径.

## What Changes

- **BREAKING** (对 spec 而言): 把 `agent-interrupts/spec.md` 的 Requirement "Cross-team poke is rejected" 措辞收窄到**MCP `poke` tool 入口**, 明确不约束内部 `poke()` 函数调用
- 新增 Requirement (或扩充已有): 内部 auto-poke 路径 (通过 `send_message({to_team})` / `broadcast_to_role` 等) 调用 `poke()` 时 MUST 绕过 cross-team 检查
- 代码: `src/mcp/poke.ts` 在 `PokeDeps` 加可选字段 `allowCrossTeam?: boolean`, 默认 false 保持现行 MCP 语义; `createAutoPokeImpl` (`src/mcp/tools.ts:76`) 传 `allowCrossTeam: true`
- 测试: `tests/poke-validation.test.ts` 里 "returns cross_team_denied" 保留不变 (MCP 入口行为不变); 新增测试验证 `poke({allowCrossTeam:true})` 跨 team 可通过; 新增一个 createAutoPokeImpl 直连 poke() 的 cross-team 集成测试 (封堵之前只 mock `FanoutDeps.poke` 而漏过真实桥接的空档)

## Capabilities

### New Capabilities

(无全新 capability)

### Modified Capabilities

- `agent-interrupts`: 把 "Cross-team poke is rejected" 的适用范围明确限定在 MCP `poke` tool 入口, 加 ADDED Requirement 允许内部调用绕过

## Impact

- **代码**: `src/mcp/poke.ts` (加 `allowCrossTeam` 字段 + 条件分支), `src/mcp/tools.ts` (createAutoPokeImpl 传 flag)
- **测试**:
  - 新增: `tests/poke-cross-team-internal.test.ts` (直接测 poke({allowCrossTeam:true}))
  - 新增: `tests/auto-poke-impl-cross-team.test.ts` (测 createAutoPokeImpl → poke() 端到端, mock 在 tmux-cli 层)
  - 保留: `tests/poke-validation.test.ts:119` (MCP 入口 cross-team 仍 denied)
- **spec**: `agent-interrupts` 需 delta
- **数据库**: 无 schema 变化; 无 migration
- **依赖**: 无新外部依赖
- **MCP client**: 无感知 — 对 MCP 客户端没有协议变化. 副作用是 cross-team `send_message` 的 auto-poke 从 "永远 guard_failed" 变成 "正常 guard + poke"
