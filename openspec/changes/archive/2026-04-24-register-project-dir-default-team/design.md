## Context

当前注册流程里 `team` 缺省统一回落到 `'default'` (`src/mcp/register-agent.ts:43`, `src/storage/agents-repo.ts:88`)。  daemon 作为独立 HTTP 进程, 不持有调用方 cwd; 调用方 (Claude Code / Codex / OpenCode) 却各自知道自己项目目录。  为了让 "同项目的 agent 自动同 team" 成为默认行为, 需要把 cwd 信息显式带进协议, 而不是依赖 daemon 自行猜测。

相关现状:
- `registerAgentInputSchema` 和 `registerClaudeSelfInputSchema` 是 `.strict()` zod schema, 新字段必须显式声明才能通过验证。
- `RegisterAgentService.register` 接收 `team?: string` 并在里面做 `team ?? 'default'`。
- MCP `initialize` 返回的 `instructions` 字段是 agent 启动时就读到的 "硬知识", 是改变 LLM 客户端默认行为的最自然入口。

## Goals / Non-Goals

**Goals:**

- `register_agent` / `register_claude_self` 调用方只需多传一个 `project_dir` 字段 (通常就是它已有的 cwd), 即可把默认 team 收敛到项目名。
- 兼容一切不传 `project_dir` 的旧调用, 行为保持与今日一致 (`team='default'`)。
- LLM 客户端 (Claude Code / Codex agent) 通过 `instructions` 和工具 description 自动遵循 "缺省传 cwd" 约定, 无需每次对话教学。

**Non-Goals:**

- 不把 `project_dir` 做成 required。
- daemon 侧不做 cwd 探测 — 完全依赖客户端显式传入 (daemon 不应依赖 request host 的环境)。
- 不改变已有 `team`(显式传入时) 的语义 — 显式 `team` 永远优先。
- 不改 `agents.team` 列类型或数据库 schema。

## Decisions

### 1. 三级优先级: `team` > `basename(project_dir)` > `'default'`

**选择**: 派生顺序固定为显式 team → project_dir 衍生名 → 静态兜底。

**理由**: 用户显式传的 team 最准; 缺 team 但知道 cwd 时, `basename` 是无歧义、可复现的自然映射; 两个都没有时才用 `'default'`, 保持与旧版完全兼容。

**替代方案**:

- `basename(project_dir)` > `team` > `'default'`: 语义上奇怪, 违反 "显式优先于默认" 的直觉, 否决。
- 只支持两级 (`project_dir` 必传, 否则 `'default'`): 破坏向后兼容, 否决。

### 2. `basename` 规范化: 小写 + trim + 拒绝空串

**选择**: `basename(project_dir).trim().toLowerCase()`; 结果空串时回落 `'default'`。

**理由**: macOS / Linux 文件系统大小写敏感但 team name 是 logical identifier, 统一小写避免 `Foo` vs `foo` 创建两个 team; trim 处理尾部斜杠导致的空 basename (`/foo/bar/` → `bar`, 但边界情况 `/` → `''`); 空串回落不然会写入无法寻址的空 team。

**替代方案**:

- 不做 lowercasing: 用户在 macOS 默认大小写不敏感 FS 上可能手误; 否决。
- sanitize 成 `[a-z0-9-]+`: 过度设计, 现有 `team` 列没有这种约束, 保持一致性不搞特殊规则。

### 3. daemon 侧做派生, 不在 schema 级做 transform

**选择**: zod schema 只接受 `project_dir: z.string().min(1).optional()`, 派生逻辑放在 `RegisterAgentService.register` 里。

**理由**: schema 只管输入形状验证, 不管业务 fallback 语义; 这样 agents-repo 调用路径 (内部也会命中同一个默认值逻辑) 能统一处理。派生函数 `deriveDefaultTeam({team, project_dir})` 可单元测试, 逻辑集中一处。

**替代方案**:

- 在 zod 里用 `.transform()` 填 team: 会让 schema 输出类型改变, 下游签名全跟着动; 否决。

### 4. `instructions` 字段合并两条约定

**选择**: 在 `src/mcp/transport.ts:34` 已有的 xats 缩写那条 `instructions` 后面追加一段新约定, 合并为单一字符串字段。

**理由**: `ServerOptions.instructions` 只接受一个 `string`, 不支持数组; 把相关约定集中在一处便于 agent 一次性读取。

**替代方案**: 无 — 协议只给一个槽位。

### 5. `register_claude_self` 与 `register_agent` 同步接入

**选择**: 两个工具都加 `project_dir` 字段, 两个 description 都追加一句。

**理由**: `register_claude_self` 是 Claude Code 的主入口, 不接入就等于大部分调用还是老行为; 两个工具语义对称, 一致性重要。

## Risks / Trade-offs

- **basename 碰撞** → 不同 workspace 下有同名项目目录时会被归到同一个 team。 Mitigation: 这是功能设计意图 (同名项目=同一逻辑 team), 用户需要隔离时应显式传 `team`。 instructions 里会写清楚。
- **LLM 客户端不遵守 `instructions` 约定** → 仍然按老逻辑不传 `project_dir`, 回落 `'default'`, 与旧行为一致, 不会坏事但也拿不到新好处。 Mitigation: 三级优先级确保无副作用; 工具 description 作为第二道提醒。
- **agents-repo 和 register-agent 两处都有 `?? 'default'`** → 如果只改一处, 另一处仍落 `'default'`, 行为分裂。 Mitigation: tasks 里明确要求两处同步改, 并写单元测试覆盖两条路径。
- **已有测试里有 `team='default'` 的 given/then 断言** → 全面下不改 project_dir 的情况下 team 仍为 default, 断言保持有效; 但新增 project_dir 后的 scenarios 必须另外写测试, 不能靠老断言兜底。 Mitigation: 在 `agent-registry` delta spec 里新增对应 scenarios, tasks 里列出需要新增/更新的测试文件。

## Migration Plan

1. 代码改动发布后, 所有不传 `project_dir` 的客户端行为不变。
2. Claude Code helper (`register_claude_self` 侧) 和 opencode / codex 客户端可以逐步升级, 在各自 self-register 脚本里加 `project_dir=$PWD`。  此升级彼此独立, 可单独回滚。
3. 无数据库迁移。
4. Rollback: 还原代码即可, `agents` 表里已写入的 team 值 (可能是项目名) 不需要回迁 — 保留为历史 team 不影响功能。

## Open Questions

- 是否需要在 `list_agents` 里也提供一个 `project_dir` 参数帮调用方快速查 "本项目下其它 agent"?  → 本变更不做, 单独提一个新变更再评估, 避免 scope 扩散。
