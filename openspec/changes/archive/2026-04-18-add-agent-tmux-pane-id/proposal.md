## Why

前置实测已经证明: 三家 code agent (Claude Code, opencode, codex) 都在同一个 aoe tmux session 的分屏 pane 里运行, 通过 `tmux paste-buffer + send-keys` 能可靠地"戳醒"任一 agent, 让它自主调用 MCP 工具.  但 daemon 本身不知道 `agent_id ↔ tmux pane` 的对应关系, 这导致"跨 agent 主动唤醒"必须由调用方带外 (OOB) 传入 pane id, 耦合松散、无法回滚、难以演进.

下一个 change (`add-poke-mcp-tool`) 将提供新 MCP tool `poke`, 调用者只需提供 `target_agent_id` + prompt, daemon 内部应能按 agent_id 查到目标 pane 并注入.  本 change 是 poke 的**纯数据层前置**, 把 tmux pane id 落到 agents 表上, 成为 daemon 侧的单一事实源.

## What Changes

- **MODIFIED**: `agents` 表加一列 `tmux_pane_id TEXT NULL` (可选, 默认 NULL, 非-tmux 场景兼容).
- **MODIFIED**: `register_agent` MCP tool 入参加可选字段 `tmux_pane_id: string`, 存入对应列.
- **MODIFIED**: `list_agents` 返回每个 agent 结构加 `tmux_pane_id` 字段 (nullable).
- **MODIFIED**: 同一 MCP session 重复 `register_agent` 时, 如带新 `tmux_pane_id`, 执行 upsert 覆盖.
- **ADDED**: 新 Requirement "Tmux pane id persistence" 声明字段语义和非-tmux 兼容性.
- 更新 `docs/configs/{claude-code,opencode,codex-cli}.md`: 指引用户在各 agent 启动后先执行 `tmux display-message -p '#{pane_id}'`, 把结果作为 `tmux_pane_id` 传入首次 `register_agent`.

## Capabilities

### Modified Capabilities

- `agent-registry`: 新增 `tmux_pane_id` 列与入参/返回字段, 以及 legacy-db 自动迁移. 不影响现有 online 判定、collision (409)、identity-mismatch (403)、last_seen_at touch 路径.

### New Capabilities

(无 — 纯字段扩展)

## Impact

- **DB migration**: 对既存数据库执行 `ALTER TABLE agents ADD COLUMN tmux_pane_id TEXT`.  SQLite 原生支持, 无需数据回填, 既有行 tmux_pane_id 自动 NULL.
- **向后兼容**: 既有 register_agent 调用不带此字段 → NULL 入库; 老的 list_agents 消费者忽略新字段即可.
- **下游依赖**: 下一个 change `add-poke-mcp-tool` 依赖本 change 提供的字段作为目标 pane 查询源.
- **非-tmux 场景**: 字段可选, 在 IDE/desktop/CI 等非-tmux 环境下 register_agent 不填 tmux_pane_id, poke tool 在后续 change 中对 NULL 返回 `tmux_pane_not_set`, 由调用方 LLM 决策降级.
- **新代码文件**: 无 (全部编辑现有 src/storage/*, src/mcp/register-agent.ts, src/mcp/tools.ts).
- **新文档**: docs/configs/* 更新, 无新建.
