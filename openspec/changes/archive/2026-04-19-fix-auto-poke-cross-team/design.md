## Context

当前 `src/mcp/poke.ts:94`:

```typescript
const callerRow = deps.db.prepare(`SELECT team FROM agents WHERE agent_id = ?`).get(deps.callerAgentId)
if (!callerRow) return { error: 'unknown_agent' }
if (callerRow.team !== target.team) return { error: 'cross_team_denied' }
```

这个分支有两个调用路径:

| 调用者 | 入口 | prompt 来源 | 应否 cross-team 允许 |
|---|---|---|---|
| 用户直接调 MCP tool `poke` | `tools.ts:491` | 调用方任意 string | **不允许** — 防任意内容跨 team 注入 |
| `send_message({to_team})` / `broadcast_to_role` 的 auto-poke | `tools.ts:76` (createAutoPokeImpl) | `buildAutoPokeHint(...)` 固定格式 `新邮件 from X, 请调 get_inbox 查看` | **允许** — `refactor-mailbox-routing` 明规定 |

`refactor-mailbox-routing` 的 `mailbox/spec.md` 里 "Cross-team auto-poke fires when recipient pane idle" 明确规定后者要能工作, 但 `agent-interrupts/spec.md` 的 "Cross-team poke is rejected" 一刀切了两条路径. 本次改动收窄第二条 spec, 让路径区分.

约束:

- **不破坏 MCP tool 入口的 cross-team 拒绝**: 直接 `poke({target, prompt})` MCP 调用仍然返回 `cross_team_denied`, `tests/poke-validation.test.ts:119` 不动
- **不新增 MCP 入参**: `allowCrossTeam` 只作为**内部函数签名**的一部分, 不暴露到 MCP schema. MCP client 看不到它
- **不修改 hint 格式**: `buildAutoPokeHint` 不变, auto-poke prompt 仍是固定 hint

## Goals / Non-Goals

**Goals:**

- G1  Cross-team `send_message` 的 auto-poke 在 recipient pane idle 时实际注入 hint, 让 `refactor-mailbox-routing` D8 / spec "Cross-team auto-poke fires when recipient pane idle" 在运行时真实成立
- G2  保留 MCP 直调 `poke` 的 cross-team 拦截不变, 不放宽对外接口
- G3  两条路径在代码层清晰区分, 避免未来复用时再次踩同一个坑
- G4  新增一条端到端集成测试, 覆盖 `createAutoPokeImpl → poke()` 这段此前只在 mock 层被测试的桥接, 把 bug 类从单测覆盖盲区收回

**Non-Goals:**

- NG1  不把 cross_team_denied 从 `poke()` 内部完全删除 — 直调路径仍然需要拦截
- NG2  不扩 `poke` MCP schema 加任何 flag, 不暴露 bypass 给外部
- NG3  不重构 poke() 拆成 pokeCore + pokeWrapper (一步够用, 过度重构)
- NG4  不改 `buildAutoPokeHint` 的格式
- NG5  不动 `self_poke_denied` / `tmux_unavailable` / `tmux_pane_not_set` / `prompt_too_long` 等其他保护

## Decisions

### D1  PokeDeps 加可选字段 `allowCrossTeam?: boolean`

```typescript
export interface PokeDeps {
  db: Database.Database
  callerAgentId: string | null
  allowCrossTeam?: boolean  // 新增; 默认 false; 仅内部 autoPokeImpl 传 true
}
```

调用侧:
- `tools.ts:76` (createAutoPokeImpl 内部): `await poke({ db, callerAgentId: args.fromAgentId, allowCrossTeam: true }, ...)`
- `tools.ts:491` (MCP tool 入口): `await poke({ db, callerAgentId }, args)` — 不传 flag, 保持默认 false

**为什么是 `PokeDeps` 而不是 `PokeInput`?** `PokeInput` 直接映射到 MCP tool 的 inputSchema (`target_agent_id`, `prompt`). 添加字段会污染 MCP schema. `PokeDeps` 是纯 TS 函数依赖, 不对外暴露.

**备选 (未采纳)**: 拆 `pokeCore(paneId, prompt)` 无校验核心函数 + `poke(deps, input)` 保留所有校验. 被否决: 当下唯一不同点只有一条分支, 一个布尔 flag 足够; 拆函数是过度抽象.

### D2  条件分支写法

```typescript
if (callerRow.team !== target.team && !deps.allowCrossTeam) {
  return { error: 'cross_team_denied' }
}
```

- 等式失败 AND flag 未置时拦截; flag 置 true 时放行
- flag 缺省为 `undefined` → falsy → 现行行为

### D3  Spec 分两条 Requirement

原 Requirement "Cross-team poke is rejected" 被 MODIFIED:

- 措辞从 "If the target's team does not equal the caller's team, the daemon MUST return cross_team_denied" 收窄为 "**The `poke` MCP tool** MUST return cross_team_denied when caller.team != target.team"
- Scenario "Cross-team target" 保留, 但 WHEN 改为 "caller invokes the `poke` MCP tool"

新增 Requirement "Internal auto-poke bypasses the cross-team check":

- 描述 `createAutoPokeImpl` 这条路径对 cross_team 约束的豁免; 明确 hint prompt 的不可变格式是豁免的前提
- Scenario "Cross-team send_message triggers real poke" 验证 auto-poke 端到端调 poke() 不再 guard_failed

### D4  新增 createAutoPokeImpl 集成测试策略

当前测试盲区: `tests/send-message-cross-team-auto-poke.test.ts` 用 mock `FanoutDeps.poke`, 不走 createAutoPokeImpl. `tests/poke-validation.test.ts` 只测 `poke()` 直接入口.  Cross-team bug 所在 "createAutoPokeImpl → poke()" 这段桥, 过去一次测试都没有.

新测试 `tests/auto-poke-impl-cross-team.test.ts`:
- 不 mock createAutoPokeImpl, 直接调 createAutoPokeImpl(db, agents) 返回的 AutoPokeFn
- 在 `src/daemon/tmux-cli.ts` 层做 mock: `_setTmuxAvailableForTest(true)`, 用 `__setCapturePaneTail` / `loadBuffer` / `pasteBuffer` / `sendEnter` 的测试钩子 (或用 vi.mock 整模块替换)
- 插入 alpha team sender + beta team target, 调 cross-team autoPoke, 断言返回 `{ ok: true }` (而非 guard_failed)

## Runtime Assumptions

Runtime Assumption Audit 扫描结果:

- 设计中出现 `默认` (默认 false, 默认行为) 与 `保留` (保留拦截) 措辞, 均指向**本仓库内**明确的现行代码行为 (`poke()` 函数现状, MCP schema 现状), 不涉及外部库默认
- 没有依赖外部库隐式默认或 "文档说是 X" 的情况; 所有判断都来自直接读取 `src/mcp/poke.ts`

### A1:  `Deps.allowCrossTeam` 缺省为 undefined → 等价于 false

**Assumption**: TypeScript 可选字段 `allowCrossTeam?: boolean` 在调用方未传时, 函数体内 `deps.allowCrossTeam` 为 `undefined`; `!deps.allowCrossTeam` 求值为 `true`, 所以 `callerRow.team !== target.team && !deps.allowCrossTeam` 等价于原来的无 flag 单一条件.

**Rationale**: 标准 TS/JS 语义; 编译时即可由类型检查验证; 现有 MCP tool 入口调用 `poke({ db, callerAgentId }, args)` 不改, 缺省保持 falsy.

**Verification**: task 1.1 RED test 里保留对 MCP 入口的 cross_team_denied 断言; task 1.2 新增对 `allowCrossTeam:true` 的 allow 断言; 两条合起来覆盖默认与显式两条分支.

## Risks / Trade-offs

| Risk | Mitigation |
|------|-----------|
| R1  未来新增另一条内部调用方 (e.g. 新工具), 作者忘了传 `allowCrossTeam: true`, 又出现同类 bug | 在 poke() 的 JSDoc 一行注释里点出 "内部 auto-poke 必须传 allowCrossTeam:true" |
| R2  把 cross_team 豁免的决定放在调用方, 容易被滥用 (将来有人不走 hint 格式也传 flag) | D3 的 spec Requirement 明确 "the prompt MUST be the hint format" 作为豁免前提; 任何 future caller 要传 flag 必须满足这条, 否则是 spec 违规 |
| R3  新测试用 vi.mock 替换 tmux-cli 整个模块, 可能与现有 `poke-e2e.test.ts` 的真实 tmux 测试相互影响 | 新测试放独立文件, 只用 `_setTmuxAvailableForTest` + stub 钩子, 不 vi.mock 整模块 |
| R4  MCP tool 入口仍拒绝 cross-team, 但人类用户可能期望 "我 poke 那边的 agent 直接送过去" — 本次没放宽 | 接受; 这是独立的 UX 问题, 如需放宽得另开 change 讨论对外 API 的 cross-team policy |

## Migration Plan

1.  合并到 main, 重新 `pnpm build`, 重启 daemon — 不涉及 DB schema, 不需要删 DB
2.  验证: 在已有 `mailbox-qa` + `system` 两个 team 的场景下, 重跑今天的 `send_message({to_team:'system', to_agent_id:<researcher>})` — 响应应 `poked:true`, researcher pane 收到 `新邮件 from X, 请调 get_inbox 查看`
3.  留存的之前三条跨 team 消息仍在 researcher 的 mailbox 里, get_inbox 可见 — 不需要重发

**Rollback**:  git revert + 重启. 无数据影响.

## Open Questions

无.  决策点已由前文讨论锁定:

1.  豁免走 `PokeDeps` flag 而不是拆 `pokeCore` (D1)
2.  spec 按路径拆两条 Requirement (D3)
3.  新增 createAutoPokeImpl 集成测试, 覆盖之前只 mock 了 fanout 层的盲区 (D4)
