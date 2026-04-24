## Why

`register_agent` 和 `register_claude_self` 在调用方没有显式指定 `team` 时一律回落到字符串 `'default'`。  实际工作中, agent 几乎总是在一个具体项目目录里运行, 用户期望同一项目下的 agent 自动归在同一个 team, 不同项目互不打扰。  当前默认值导致所有未指定 team 的注册都挤进 `default`, 跨项目 agent 互相看得见、广播互相干扰, 而手动每次都指定 team 又繁琐 (项目名动辄十几个字符)。

## What Changes

- `register_agent` 和 `register_claude_self` 的输入 schema 新增可选字段 `project_dir: string`.
- daemon 计算默认 team 的规则从 `team ?? 'default'` 改为 `team ?? basename(project_dir) ?? 'default'`.  只有当 `team` 和 `project_dir` 都缺省时, 才回落到 `'default'`.
- MCP server 的 `instructions` 字段追加一条约定: 调用 `register_agent` / `register_claude_self` 时, 如果用户未显式指定 team, 默认应传当前工作目录作为 `project_dir`。
- `register_agent` 和 `register_claude_self` 的工具 `description` 各加一句指示, 与 instructions 一致。
- **不引入 breaking change**: `project_dir` 是可选字段; 已有调用 (不传 `project_dir`, 不传 `team`) 行为保持为 `team='default'`。

## Capabilities

### New Capabilities

(无)

### Modified Capabilities

- `agent-registry`: `register_agent` 和 `register_claude_self` 的输入契约增加可选 `project_dir`, 默认 team 派生规则从纯 `'default'` 改为 "team > basename(project_dir) > 'default'" 的三级优先级。
- `mcp-transport`: MCP server initialize 返回的 `instructions` 字段内容新增 team 默认值约定 (仍保持同一字符串字段, 仅内容扩充)。

## Impact

- **代码**: `src/mcp/tools.ts` (两个 input schema + 两个工具 description), `src/mcp/register-agent.ts:43` 和 `src/storage/agents-repo.ts:88` (默认值派生), `src/mcp/transport.ts:34` (instructions 文本追加)。
- **API 契约**: `register_agent` / `register_claude_self` 的 JSON 输入 schema 增加一个可选字段; 旧调用全部保持兼容。
- **数据**: 无 schema 迁移 — 派生逻辑在写入前完成, `agents.team` 列类型不变。
- **客户端**: 推荐 Claude Code / Codex / OpenCode 注册 helper 默认带上 `project_dir=cwd`, 但不是硬要求, 缺省时兜底为旧行为。
- **文档**: `README.zh-CN.md` / `README.md` / `docs/configs/*.md` 里 register 示例需要补一条 `project_dir` 参数的说明 (可以在 tasks 阶段逐一确认)。
