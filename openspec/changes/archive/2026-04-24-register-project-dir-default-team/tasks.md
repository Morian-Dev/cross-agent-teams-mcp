## 1. 公共派生函数

- [x] 1.1 在 `src/mcp/register-agent.ts` (或与之紧邻的新文件) 导出 `deriveDefaultTeam({ team?: string; project_dir?: string }): string`, 规则为: `team` trim 后非空 → 用它; 否则若 `project_dir` 存在 → `basename(project_dir).trim().toLowerCase()` 非空则用它; 否则回落 `'default'`
- [x] 1.2 为 `deriveDefaultTeam` 写单元测试 (tests/unit/derive-default-team.test.ts 或并入现有同模块测试), 覆盖: 显式 team 优先、project_dir 正常目录名、trailing slash、大小写、`/` 空 basename 回落、两个都缺省回落

## 2. Schema 接入

- [x] 2.1 `src/mcp/tools.ts` 中 `registerAgentInputSchema` 新增 `project_dir: z.string().min(1).optional()`, 保持 `.strict()` 约束
- [x] 2.2 `src/mcp/tools.ts` 中 `registerClaudeSelfInputSchema` 新增 `project_dir: z.string().min(1).optional()`, 保持 `.strict()`
- [x] 2.3 `executeRegister` 的入参 TS 类型和转发到 `registerSvc.register` / `registerCodexSelfSvc.register` 的调用处补传 `project_dir`
- [x] 2.4 `register_claude_self` 的 handler 同步把 `project_dir` 转发给底层 register 路径 (保持与 `register_agent` 共享同一派生函数)

## 3. 业务逻辑改写

- [x] 3.1 `src/mcp/register-agent.ts:43` 的 `team ?? 'default'` 改为 `deriveDefaultTeam({ team: input.team, project_dir: input.project_dir })`; `RegisterAgentInput` 类型增加可选 `project_dir?: string`
- [x] 3.2 `src/storage/agents-repo.ts:88` 同样改为调用 `deriveDefaultTeam(...)`; `AgentsRepoRegisterInput` 也增加可选 `project_dir?: string`
- [x] 3.3 确认 `RegisterCodexSelfService` / `RegisterOpencodeSelfService` 以及 `bind_opencode_session` 等路径没有自己的 team 默认兜底绕过这两处; 如有, 同步改造
- [x] 3.4 确保 `project_dir` 仅用于派生, 不写入 `agents` 表, 不返回在 `register_agent` / `register_claude_self` 的响应中

## 4. MCP instructions 与工具描述

- [x] 4.1 `src/mcp/transport.ts:34` 的 `McpServer` 构造 `instructions` 字段在已有 xats 缩写句后追加一段: 说明 "注册时 (`register_agent` / `register_claude_self`) 如果用户未显式指定 `team`, 默认传 `project_dir`=当前工作目录 (cwd), daemon 会用它的 basename 作为 team 默认值; 都不传时回落 `'default'`"
- [x] 4.2 `src/mcp/tools.ts` 中 `register_agent` 工具注册处的 `description` 字符串数组追加一条与 instructions 一致的短句 (鼓励 LLM 默认传 `project_dir`)
- [x] 4.3 `src/mcp/tools.ts` 中 `register_claude_self` 工具注册处的 `description` 字符串数组追加同样指示

## 5. 测试

- [x] 5.1 在 `tests/register-agent-*.test.ts` 系列新增 case: `project_dir='/x/y/cross-agent-teams-mcp'` 且无 team → 结果 `team='cross-agent-teams-mcp'`
- [x] 5.2 新增 case: trailing slash / 混合大小写归一化 → 符合 spec scenarios
- [x] 5.3 新增 case: 显式 `team` 优先于 `project_dir`
- [x] 5.4 新增 case: `project_dir='/'` (basename 空) 回落 `'default'`
- [x] 5.5 新增 case: `project_dir` 不出现在 `list_agents` 响应 / agents 行持久化字段
- [x] 5.6 在 `register_claude_self` 对应测试中复用 5.1-5.4 的关键 case (至少一条覆盖派生成功, 一条覆盖回落)
- [x] 5.7 在 mcp-transport 层面的 initialize 测试 (如 `tests/mcp-transport-*.test.ts` 或同等) 断言 `instructions` 字段非空, 且包含 `xats`, `cross-agent-teams`, `project_dir` 这三个子串
- [x] 5.8 既有 `Team defaults to "default" when omitted` 断言需要确认仍然通过 (没传 `project_dir` 时行为不变); 如原断言名匹配 MODIFIED scenarios 则更新断言名

## 6. 文档 & 客户端 helper

- [x] 6.1 `README.zh-CN.md` 与 `README.md` 中 `register_agent` / `register_claude_self` 示例新增 `project_dir` 字段的一行说明 (注册示例可以改成带 `project_dir` 的推荐写法)
- [x] 6.2 `docs/configs/claude-code.md` 中 `register_claude_self` 示例追加 `project_dir` 字段, 并在注释里点明默认行为
- [x] 6.3 `docs/configs/codex-cli.md` / `docs/configs/opencode.md` 如果有注册示例, 同步更新; 没有的话跳过
- [x] 6.4 `plugins/*/src/cli.ts` 或自注册 helper 脚本 (如 `scripts/codex-self-register*`) 中, 如果已经有 `register_agent` 调用, 新增 `project_dir: process.cwd()` 字段; 如果这些 helper 是纯 docs 或由外部构造, 仅需 docs 更新, 不改 runtime 行为 — 评估后 commit

## 7. 验证

- [x] 7.1 运行 `tsc --noEmit` 通过
- [x] 7.2 运行项目既有测试 (`bun test` 或 `pnpm test` 视项目实际命令) 全部通过
- [x] 7.3 `openspec validate --change register-project-dir-default-team` 通过
