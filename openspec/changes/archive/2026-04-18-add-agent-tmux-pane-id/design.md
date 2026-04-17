# Design — add-agent-tmux-pane-id

## Context

Phase 2 e2e 测试 (2026-04-17) 已证实 aoe + tmux 布局下, 三家 code agent 分别占据同一 session 不同 pane, aoe 通过 tmux option `@aoe_agent_pane` 存储确定的 pane id (`%42` 风格), 外部 `tmux paste-buffer -t %42 -p && tmux send-keys -t %42 Enter` 能唤醒目标 agent 自主调用 MCP 工具.  但 daemon 端 agents 表目前只有身份/liveness 字段, 无任何 pane 信息.  这是引入"由 MCP tool 驱动的跨 agent 唤醒能力"前的数据层空洞.

## Goals

1. 用最小代价把 `tmux_pane_id` 落到 agents 表和 register_agent / list_agents 的 API 表面.
2. 保持字段**可选**, 不破坏非-tmux 场景 (IDE / desktop / CI).
3. 保持与既有数据库的向后兼容 (legacy-db 启动时自动补列).
4. 不耦合任何 "怎么用这个字段" 的逻辑 (即不引入 poke / bridge, 那是下一个 change).

## Non-Goals

- **不做**: 自动探测 caller 所在 pane (daemon 看不到 caller 的 tmux 环境, 只能由 caller 自报).
- **不做**: pane id 格式校验 (tmux pane id 标准是 `%<integer>`, 但未来可能有非-tmux 来源, 仅校验非空字符串).
- **不做**: 更新 `tmux_pane_id` 的独立 tool (全部走 re-register 的 upsert 路径, 避免多条修改入口).
- **不做**: 删除 tmux_pane_id 的独立操作 (re-register 时传空字符串或省略均视为"不变", 强制清空可用专门值; 本次不引入语义复杂度).

## Key Decisions

### 1. 字段必填性: 可选 (选项确认见 Phase 1 Q2)

**决策**: `tmux_pane_id TEXT NULL`, 默认 NULL.

**理由**:
- 未来非-tmux 场景 (desktop app / IDE / CI headless runner) 无法提供 pane id, 必填会把这些场景挡在协议外.
- 可选对现有 register_agent 完全向后兼容, 既有调用方零改动.
- Poke tool (下个 change) 在查到 NULL 时返回 `tmux_pane_not_set`, 由调用方 LLM 决策 fallback (例如: 降级到走 SSE 推送 / 提示用户手工介入).

**拒绝的替代方案**:
- **必填**: 否定, 见上.
- **条件必填 (有 $TMUX env 才必填)**: daemon 看不到 caller 的 env, 该方案不可行.

### 2. DB migration: SQLite ALTER TABLE 原地加列

**决策**: daemon 启动时检测 `PRAGMA table_info('agents')` 是否含 `tmux_pane_id`, 缺失则 `ALTER TABLE agents ADD COLUMN tmux_pane_id TEXT`.

**理由**:
- SQLite 原生支持在 live table 上 `ADD COLUMN`, 对既有行自动 NULL 填充, 不需要数据迁移.
- 对 fresh database, 直接在 CREATE TABLE 语句里带上新列即可.
- 不引入 migration 版本号框架 — 现阶段 agents 表 schema 演进简单, `PRAGMA table_info` 幂等检查够用.  待未来需要多版本迁移链时再引入专门子系统.

**拒绝的替代方案**:
- **引入正式 migrations 框架 (drizzle-kit / sqlite migration files)**: 杀鸡用牛刀, 且与项目当前"手写 DDL"的最小化风格冲突.

### 3. 字段更新路径: 走现有 register_agent upsert, 不引入独立 tool

**决策**: 同一 MCP session 再次调用 `register_agent({ tmux_pane_id: '%99' })` 时, 覆盖既有行的 tmux_pane_id.  现有 "Repeated register_agent within same session updates metadata" requirement 已经保证整体 upsert 语义, 本 change 只需确认 upsert 涵盖新列.

**理由**:
- 减少 API 表面, 不需要新的 `update_agent_pane` tool.
- tmux pane id 实际上在 agent 生命周期内很少变化 (除非用户 Ctrl+B & 杀了 pane 再 split 一次), 所以频率极低.
- 如果 pane 换了, agent 重新启动即重新 register, 自然走 upsert.

**拒绝的替代方案**:
- **独立 `update_tmux_pane_id` tool**: API 膨胀, 无实际需求驱动.

### 4. list_agents 总是返回字段, 值可为 null

**决策**: `list_agents` 返回结构里 `tmux_pane_id?: string | null` 作为稳定字段.

**理由**:
- 使用方 (未来 poke tool) 通过 SELECT 拿全字段即可, 不需要 "条件暴露".
- 老的 list_agents 消费者忽略未知字段即可, 不影响兼容.

## Risks

| 风险 | 可能性 | 影响 | 缓解 |
|---|---|---|---|
| SQLite `ALTER TABLE ADD COLUMN` 在 WAL 模式下短时锁表 | 低 | 启动期毫秒级阻塞 | 仅在 boot 阶段执行, 不在热路径, 影响可忽略 |
| pane id 格式未来扩展 (非 tmux 来源) | 中 | schema 过严会阻碍扩展 | 字段类型 TEXT, 不强制格式正则, 保留灵活度 |
| 用户 re-split pane 导致 pane id 失效, agent 不重新 register | 中 | Poke 会戳到死 pane | 由 poke tool (下一个 change) 通过 capture-pane 验活处理, 不是本 change 的问题 |
| docs 指引用户"先 tmux display-message 再 register" 步骤繁琐 | 中 | 用户懒得做 → tmux_pane_id 多数为 NULL | 本 change 不解决, 未来可考虑在 MCP server onboarding hint 里自动指引 (不在本次 scope) |

## Alternatives Considered

1. **不改 agents 表, 让 poke tool 的调用方每次传 pane id**: 拒绝, 违反 "daemon 作为单一事实源" 原则, poke 调用契约松散.
2. **新增独立 `agent_panes` 关联表**: 过度设计.  当前 1:1 关系, 一列足够.
3. **用 JSON 列存 `meta` blob, 把 pane id 塞进去**: 不利于 SELECT 查询性能, 且 schema 可读性下降.

## Rollout

- Phase 2 apply 全部任务通过后, daemon 重启即自动执行 ALTER TABLE.
- 已有 agents 表数据原样保留, tmux_pane_id 列对既存行为 NULL.
- 现有 register_agent 调用方无任何改动必要 (字段可选).
- 文档 (`docs/configs/*.md`) 会在本 change 同步更新, 指引用户显式传 pane id.
