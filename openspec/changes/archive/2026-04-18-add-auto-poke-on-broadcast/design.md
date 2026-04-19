## Context

`add-auto-poke-on-send` 让 `send_message` 在单发 / role-fanout 场景默认 auto-poke + guard. `add-auto-poke-retry-backoff` 在 guard_failed 时排 3 次后台 retry (30s/3min/10min). 两者已经在 `auto-poke-fanout.ts` 中以并行 `Promise.all` 实现, 且 `BroadcastService` 已经接好 fan-out 调用 — 唯一区别是 broadcast 的 default 守在 `auto_poke=false`.

E2E 验证 broadcast 在默认下"无人接听", 决定翻 default.

## Goals / Non-Goals

**Goals**:

- 翻转 `BroadcastService.broadcast()` 的默认 `auto_poke` 为 `true`.
- 同步更新 `broadcast` MCP tool description, 反映新默认.
- 保留 `auto_poke: false` opt-out 路径 (LLM 自判"不紧急的状态推送"时使用).
- 复用现有 fan-out 并行 + retry-backoff, 无需新增模块.
- 更新现有 `tests/broadcast-auto-poke.test.ts` 旧用例语义, 增加 opt-out 用例.
- spec 反向 delta: REMOVE 旧 "opt-in" Requirement 和 anti-poke 历史段落, ADD 新 default-on Requirement.

**Non-Goals**:

- 不改 fan-out 实现 (`auto-poke-fanout.ts`).
- 不改 retry-backoff 实现 (`poke-retry.ts`, 排程依然是 30s/3min/10min).
- 不改 quiet-guard (`poke-guard.ts`, 依然 `POKE_QUIET_MS` 默认 2000).
- 不改 send_message 行为.
- 不引入"per-recipient retry 开关"或"广播专用 backoff"; broadcast 与 send_message 在 retry 行为上完全一致.

## Decisions

### Decision 1: opt-out 而非删参数

**选择**: 保留 `auto_poke?: boolean` 参数, 翻 default 为 `true`.

**理由**: agent 可能在某些场景 (例如发"我开始干活了"这种 trace-level 广播) 不希望打扰别人. 删参数 = 强制 poke 所有人, 失去 LLM 的判断空间. 与 send_message 的 API 一致性也要求保留 opt-out.

**替代被驳回**: "永远 poke" — 见上文.

### Decision 2: 并行 fan-out, 不串行

**选择**: 现有 `auto-poke-fanout.ts` 已经 `Promise.all`. 不动它.

**理由**: N 个 recipient 各自 2s quiet-guard, 串行总耗时 N×2s 不可接受 (典型 3-4 人团队 = 6-8s 每个 broadcast 调用). 并行下总耗时 ~2s + tmux capture 调度抖动. tmux `capture-pane` 是 read-only 操作, 不存在并发竞争.

**替代被驳回**: "为了避免 tmux flooding 串行" — capture-pane 极其轻量 (<10ms), 4 个并发对 tmux daemon 完全无压力.

### Decision 3: spec delta 走 REMOVED + ADDED, 不走 MODIFIED

**选择**: REMOVED 旧 `Broadcast auto-poke is opt-in` Requirement; ADDED 新 `Broadcast auto-poke default with parallel fan-out` Requirement (新名字, 新内容).

**理由**: 默认值翻转 + 措辞反向 + 场景大改, MODIFIED 实现起来等于全文重写, 不如 REMOVED + ADDED 直观且 archive log 清晰. 同样的逻辑用在 `Fire-and-forget delivery contract for send_message and broadcast` 上 — 它对 broadcast 的约束 (clauses 2/4 关于 broadcast) 与新 default 直接冲突, 我们 MODIFIED 这条 Requirement 移除 broadcast 部分, 改名为 send_message 专属.

**替代被驳回**: "用 MODIFIED 翻转 default" — openspec MODIFIED 没有"翻 default 值"这种 fine-grained 操作, 必须重写整个 Requirement 体, 维护成本与 REMOVED+ADDED 等同但 diff 可读性更差.

### Decision 4: archive 顺序依赖

`add-auto-poke-on-send` 必须先 archive (它的 ADDED Requirements 才进 main spec); 本 change 必须后 archive (它的 REMOVED 才能命中目标).

**风险**: 如果用户颠倒顺序, archive 会报"Requirement not found". 通过 proposal.md 顶部段落 + tasks.md 最后一项 manual-verify 强提示.

**替代被驳回**: "把两个 change 合并" — 用户明确说 "增加 change", 不要改已完成的工作.

### Decision 5: response 字段不变

`broadcast` 已经返回 `poked`, `poke_skip_reasons`, `retry_scheduled`, `retry_delays_s`. 翻 default 不改 schema. 测试 / 客户端无需调整字段断言, 只需调整"默认 auto_poke 时 poked 应该是 true"这种值断言.

## Risks / Trade-offs

- **性能**: broadcast 默认同步等 ~2s. 之前默认是 ~10ms (纯落盘). 这是用户已知接受的代价 — broadcast 本来就不是高频调用 (1 次 / 几秒级别人类决策). 测试 env 调 100ms 避免慢测.
- **broadcast spam**: 在大 team (>10 agent) 场景下默认 poke 所有人会更多噪音. 当前部署不会出现此规模, 但若未来扩展, 可能需要再加"team_size 阈值自动 opt-out"逻辑. 本 change 不做.
- **guard 假阳率**: 与 send_message 共享, 不引入新风险.
- **archive 顺序错配**: 见 Decision 4.

## Migration Plan

1. 用户调用方代码无需修改 (默认值翻转, 显式 `auto_poke:true` 仍合法).
2. 若有历史代码假设 "broadcast 不会 poke", 需要显式传 `auto_poke:false`. 当前代码库已检查 — 无此假设.
3. archive 顺序: `add-auto-poke-on-send` → `add-auto-poke-on-broadcast`.

## Open Questions

(无)
