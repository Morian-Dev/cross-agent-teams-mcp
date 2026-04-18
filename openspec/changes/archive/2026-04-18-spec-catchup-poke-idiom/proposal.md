## Why

2026-04-18 两次"轻量直修"已把两项 poke-related UX 改动提交到 main 分支, 但 `openspec/specs/*` 里三个 capability 的主 spec 还未反映这些已 ship 的行为变更:

1. **agent-registry**: `register_agent` 返回结构在 tmux_pane_id 缺失时多一个 `hint` 字段 (commits `8a11198` + `6a40f90`).  main spec 的 "register_agent uses MCP session id as agent_id" Requirement 仍写返回 `{ agent_id, team }` 而未提 hint.
2. **mailbox**: `send_message` / `broadcast` tool description 新加了 "fire-and-forget + optional poke follow-up" idiom (commits `6e255ab` + `977e9d7`).  main spec 未声明 "这两个 tool 不会 auto-poke, 需要调用方自行 chain poke 以即时唤醒".
3. **task-list**: `task_add` tool description 同样新加了 poke follow-up 指引.  main spec 未描述.

代码、测试 (tests/register-agent-hint.test.ts 6 tests + tests/tool-descriptions-poke-hint.test.ts 5 tests)、文档 (docs/configs/*) 都已经就位.  本 change 是**回溯性 spec-catchup**: 把上述三处行为变化明文写进 main spec, 让 spec ↔ code 一致.

## What Changes

- **MODIFIED (agent-registry)**: `register_agent uses MCP session id as agent_id` requirement — 返回结构加可选 `hint?: string` 字段语义, 加两个 scenario (有 / 无 tmux_pane_id).
- **ADDED (agent-registry)**: `register_agent response hints when tmux_pane_id missing` requirement — 明确 3 种触发条件 (omit / empty / whitespace) 下 hint 必现, 提供时必不现.
- **MODIFIED (mailbox)**: `send_message requires exactly one recipient field` requirement — 补一条 "send_message does not auto-poke recipients; callers MAY chain `poke({ target_agent_id, prompt })` for immediate delivery".
- **MODIFIED (mailbox)**: `broadcast excludes sender` requirement — 补一条 "broadcast does not auto-poke any recipient; callers MAY iterate list_agents and poke each target explicitly".
- **ADDED (mailbox)**: `Fire-and-forget delivery contract` requirement — 总结两个 tool 的 "persist-only, caller-chains-poke" 契约, 并声明 tool description SHOULD advise 调用方这个模式.
- **MODIFIED (task-list)**: `task_add creates a pending task` requirement — 补一条 "task_add does not auto-poke any agent; callers MAY chain poke to nudge a specific agent".
- **ADDED (task-list)**: `task_add tool description advises poke follow-up` requirement — 声明 tool description SHOULD 在注册时暴露 poke 组合模式.

## Capabilities

### Modified Capabilities

- `agent-registry`: 补齐 hint 字段语义.
- `mailbox`: 补齐 fire-and-forget + poke follow-up 契约.
- `task-list`: 补齐 task_add + poke follow-up 契约.

### New Capabilities

(无 — 纯补 main spec, 无新功能)

## Impact

- **Retroactive**: 本 change 不产出任何 production code / test file.  全部 scenarios 都由已 ship 的测试文件 (`tests/register-agent-hint.test.ts`, `tests/tool-descriptions-poke-hint.test.ts`) 覆盖, 无需 RED → GREEN.  Task kind 全部为 `build-check` (跑现有 suite 确认 spec scenario 已 satisfied) + 一个 `manual-verify` 让用户确认 spec delta 与 shipped code 一致.
- **No DB change**, **no wire-format field added beyond what already shipped**.
- **没有 breaking**: 所有新 scenario 都对应已经 GREEN 的行为; 老 spec 的 Requirement 仍然保留, 只是扩展 body + 追加 scenarios.
- **目的**: 让 `openspec validate --strict` 通过, 保持 openspec 审计链的完整性, 未来 change 仍可基于干净的 main spec 写 delta.
