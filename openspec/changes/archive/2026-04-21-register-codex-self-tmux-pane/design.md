## Context

`register_codex_self` 目前是 Codex 的推荐注册入口, 但它只负责探测 app-server thread 并登记 `delivery.kind='codex-appserver'`.  与此同时, 仓库已经有一套成熟的 tmux pane 发现能力: `detect_tmux_pane` 工具对外暴露, `detectTmuxPane(...)` 提供了可复用的底层实现, `register_agent` 的文案也一直在引导调用方自行提供 pane id.

问题在于这两条路径没有收束到一起.  真实使用里, agent 往往直接调用高层入口 `register_codex_self`, 不会再手动跑一次 pane 探测或补一次 `register_agent`.  结果就是 Codex agent 注册后常常只有 app-server delivery, 没有 `tmux_pane_id`, 让 tmux 侧触达与排障信息都变差.

这个改动跨越 `tools.ts`, `register-codex-self.ts`, `tmux-pane-detect.ts` 的接线, 但不涉及新的持久化结构和 transport 语义.  现有 `codex-appserver` 显式 delivery 在运行时失败不 fallback 到 tmux 的规则必须保持不变.

## Goals / Non-Goals

**Goals:**

- 让 `register_codex_self` 在成功登记 Codex delivery 时, 尽量同时登记 `tmux_pane_id`
- 允许调用方在高层工具里直接提供 pane id 或 pane-detect hints, 减少额外工具调用
- 复用现有 Codex tmux pane 探测逻辑, 避免重复实现另一套匹配规则
- 保持 tmux pane 探测为 best-effort, 不让它阻塞 Codex 主注册流程

**Non-Goals:**

- 不改变 `codex-appserver` 的运行时分派语义
- 不新增新的 delivery kind 或新的数据库列
- 不扩展 `detect_tmux_pane` 的算法或候选打分模型, 除非实现接线时发现缺口

## Decisions

### 决策 1: `register_codex_self` 新增可选 pane 输入与 hint 输入

`register_codex_self` 输入增加可选字段:

- `tmux_pane_id`
- `cwd`
- `tty`
- `title_contains`

这样调用方可以按精度分层使用:

- 已知 pane id 时直接传 `tmux_pane_id`
- 不知道 pane id 但知道上下文时传 hint
- 完全不知道时走默认 Codex 探测

备选方案是完全不改输入, 只在内部盲探测.  这对单实例场景足够, 但在多 pane / 多 Codex 共存时容易产生歧义, 也让调用方失去纠偏手段.

### 决策 2: 显式 `tmux_pane_id` 优先, 否则再走 Codex pane 探测

注册流程按下面顺序决策 pane:

1. 如果输入带了可用的 `tmux_pane_id`, 直接使用
2. 否则调用 `detectTmuxPane({ agent: 'codex', cwd, tty, title_contains })`
3. 只有当 detector 返回唯一 `ok` pane 时才写入 `tmux_pane_id`
4. 若返回 `not_found` / `ambiguous_match` / `tmux_unavailable`, 则视为 “没有新的 pane 值”

这样可以最大化尊重调用方显式意图, 同时与现有 detector 语义保持一致.

### 决策 3: tmux pane 探测失败不升级为 `register_codex_self` 错误

`register_codex_self` 的主职责是找到唯一可恢复的 Codex thread 并登记 Codex delivery.  tmux pane 只是补强元数据, 不是主成功条件.

因此:

- Codex websocket / protocol / thread 探测失败, 仍按现有错误返回
- tmux pane 相关失败不新增顶层错误, 只是在注册调用里省略 `tmux_pane_id`

备选方案是把 tmux 探测失败做成 hard error.  这会把一个本来可用的 Codex registration 变成脆弱链路, 与 “best-effort 补全元数据” 的目标相反.

### 决策 4: 复用 `RegisterAgentService` 现有的 pane 持久化语义

`RegisterAgentService` / `AgentsRepo` 已经定义好了 pane 字段的更新策略:

- 新建时, 省略 pane → `NULL`
- 复用注册时, 省略 pane → 保留旧值
- 提供新 pane → 覆盖旧值

`register_codex_self` 不自己重写这套规则, 而是只决定 “这次是否拿到了新的可用 pane 值”, 然后把结果交给现有注册服务.  这样行为与 `register_agent` 保持一致, 测试面也更小.

## Risks / Trade-offs

- [多 Codex 实例仍可能歧义] → 保留 `ambiguous_match` 的 best-effort 语义, 并允许调用方显式传 `tmux_pane_id` 或 hint 缩小范围
- [高层工具输入变多] → 只增加少量可选字段, 保持原有最小调用方式不变
- [内部复用 detector 让实现跨模块] → 通过在 service 层注入 detector 依赖控制耦合, 测试中可直接 mock
- [调用方误以为这意味着运行时会 fallback 到 tmux] → 在文档和工具描述里明确: 这是注册补强, 不是 transport fallback 变更
