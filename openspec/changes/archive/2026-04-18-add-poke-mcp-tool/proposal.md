## Why

前两个 change 已经落地:
- `build-agent-teams-mcp`: MCP daemon + 14 业务 tool + SSE + 三 agent 连通.
- `add-agent-tmux-pane-id`: agents 表加 `tmux_pane_id` 字段, register/list_agents 支持, 为 daemon 侧 "按 agent_id 查目标 tmux pane" 提供数据层基础.

2026-04-17 的端到端实测证实: 三家 code agent (Claude Code / opencode / codex) 在同一 tmux session 的分屏 pane 下, 通过外部 `tmux paste-buffer + send-keys Enter` 能可靠地"戳醒"任一目标 agent, 目标 agent 收到注入 prompt 即自主调用 MCP 工具.  但目前这一切要靠 human / 外部脚本手动执行; agent 之间互相唤醒没有 in-band 渠道.

本 change 引入 **新 MCP tool `poke`**: 任何已 register 的 agent 可直接通过 tool 调用, 让 daemon 代为对**同 team 的另一个** agent 所在的 tmux pane 注入 prompt, 并立即返回该 pane 的前后快照供调用方 LLM 自主判断.  这是跨 agent 主动唤醒的最小化 in-band 协议, 不依赖外部 bridge 进程.

## What Changes

- **ADDED**: MCP tool `poke({ target_agent_id: string, prompt: string })` → `{ ok, pane_id, pane_tail_before, pane_tail_after }` 或 `{ error: <code>, detail? }`.
- **ADDED**: 新 capability `agent-interrupts`, 聚合当前的 poke 和未来可能的 cancel / stop 等 cross-session interrupt 行为.
- **ADDED**: daemon 内部以 `child_process.execFile` 调 tmux CLI 执行 `capture-pane`, `set-buffer`, `paste-buffer -p`, `send-keys` 四组命令, 参数通过 execFile 参数数组传递 (无 shell, 无命令注入面).
- **ADDED**: 错误 envelope 约定 (9 种 error code + 可选 `detail`).
- **ADDED**: prompt 最大长度限制 8 KB (UTF-8 字节).
- **ADDED**: 权限边界 — caller 必须已 register; target 必须同 team; target 不能是 caller 自己; target.tmux_pane_id 必须非空.
- **MODIFIED**: `mcp-transport` 下的 "Tool registration" 清单隐含增加一项 (spec 侧在 mcp-transport delta 里不显式列, 仅通过 agent-interrupts capability 的 tool registration requirement 声明).
- 更新 `docs/configs/README.md`: 在"Manual scenario"之后加一节"Cross-agent poke scenario"演示 A poke B → B 自主处理.

## Capabilities

### New Capabilities

- `agent-interrupts`: 跨 session 的 agent 唤醒 / 中断语义.  本 change 交付 `poke` 一个 tool; 未来可扩展 `cancel_agent` / `stop_streaming` 等.

### Modified Capabilities

(无 — `poke` 不 touch agent-registry / mailbox / contract-registry 等现有 capability 的 schema 或 API.)

## Impact

- **Runtime 依赖**: daemon 运行环境必须能 `execFile('tmux', ...)`.  无 tmux 环境下调 poke 会返回 `{ error: 'tmux_unavailable' }`, 不影响其他 tool; integration test 在无 tmux 环境下 skip.
- **Security**: 所有 tmux 命令通过 execFile 参数数组传递, 不拼 shell 字符串.  prompt 以 `tmux load-buffer` 或 `tmux set-buffer` 从 stdin 喂入, 不做字符转义, bracketed paste (`-p`) 让目标 agent TUI 识别为"粘贴数据"而非命令序列.
- **Backward compatibility**: 无.  新增 tool, 不改任何既有 API.
- **Client / agent 侧要求**: target agent 必须已调 register_agent 并传入 `tmux_pane_id` (靠 Change 1 提供).  未传 pane_id 的 agent 被 poke 时返回 `{ error: 'tmux_pane_not_set' }`.
- **不 ship**: counter-based 防滥用、自动 pane 活性巡检、notification 推回 caller 的 event (后续可加).
- **新代码文件**:
  - `src/daemon/tmux-cli.ts` (execFile 包装 + capture/paste-buffer/send-keys helpers)
  - `src/mcp/poke.ts` (tool registration + 业务检查 + 编排 tmux-cli)
- **测试**: `tests/tmux-cli.test.ts` (unit, mock child_process), `tests/poke-schema.test.ts` (unit, 所有 error paths), `tests/poke-e2e.test.ts` (integration, 真 tmux, skip if not available).
- **未来衔接**: Change 3 (`improve-mcp-session-keepalive`) 不依赖本 change.  bridge 进程 (如果未来再引入) 会调用本 change 的 `poke` tool 代替外部 send-keys.
