## Why

`add-auto-poke-on-send` 上线后 e2e 暴露: 目标是 TUI-heavy agent (Claude Code 主 pane %71) 时, 它的 spinner / 流式 token / 光标闪烁让 pane tail 每秒都变, 2s guard 必然 fail, 从而 **agent → opus 方向几乎每次 auto_poke 都 guard_failed**.  结果: 消息落 mailbox, 但 opus 不会被戳醒; 只有 opus 下次主动 `get_inbox` 才看到, poke 链路在这个方向**断了**.

guard 本意是"别在对方忙着时打扰", 但"忙"和"UI 动画"被 tail hash 混同了.  更准确的判据是"对方过了一阵还是没自己 pull 到", 也就是**给它时间, 再看**.

方案: **退避重试**.  guard_failed 时, daemon 在后台排 3 次 retry, 间隔 30s → 3min → 10min.  任一轮 guard pass → poke, 停止后续 retry.  期间若 recipient 的 `last_seen_at` 变新 (意味着它自己 pull 了 inbox / 做了任何 MCP 调用), 立刻取消剩余 retry, 避免重复唤醒.

## What Changes

- **ADDED**: `src/mcp/poke-retry.ts` — 新模块.  管理 `scheduleRetry(ctx)` / `cancelRetries(messageId, agentId)` / `clearAll()`.  内存 `Map<retryKey, { timer, attempt }>`.  超时回调重跑 guard → poke → 排下一轮.
- **MODIFIED**: `src/mcp/auto-poke-fanout.ts` 在每个 recipient 的处理尾部, 若结果是 `guard_failed` 且 recipient 有 `tmux_pane_id`, 调用 `scheduleRetry` 排队 (30s / 180s / 600s).
- **MODIFIED**: `src/mcp/send-message.ts` + `src/mcp/broadcast.ts` response 新增:
  - `retry_scheduled: boolean` — 是否至少 1 个 recipient 进了 retry 队列
  - `retry_delays_s: number[]` — 排队时使用的退避序列 (固定 `[30, 180, 600]`, 方便 LLM 看出来 "下次 30s 后", 不必猜)
- **MODIFIED**: `src/daemon/server.ts` `onClose` hook 调 `poke-retry.clearAll()` 防止 test / shutdown 遗漏 timer.
- **MODIFIED**: `src/mcp/tools.ts` `send_message` / `broadcast` description 加一句 "guard_failed recipients are scheduled for 3 background retries at 30s / 3min / 10min; recipient activity cancels".
- **ADDED**: 完整测试:
  - unit: poke-retry 模块 (用 vi.useFakeTimers, 验证 3 轮定时 + 取消 + shutdown cleanup)
  - integration: send_message guard_failed → response 带 retry_scheduled:true, tick 30s → guard pass 走 poke, recipient activity → 取消
  - regression: no_pane / self / tmux_unavailable 不进 retry (它们不是"暂时忙", 重试毫无用处)
- **ADDED**: `openspec/specs/mailbox/spec.md` 新 Requirement "Auto-poke retry with backoff on guard_failed"
- **MODIFIED**: `docs/configs/README.md` "Auto-poke on send" 节追加 "Retry on guard_failed" 子段.

## Capabilities

### Modified Capabilities

- `mailbox`: 加"guard_failed 后后台 retry with backoff" 行为 + response 字段.  其他 send_message / broadcast / auto_poke / guard 行为不变.

### New Capabilities

(无)

## Impact

- **不改 DB schema** (retry 状态在内存).  daemon 重启丢失未触发的 retry — acceptable for MVP: 最多影响 10min 内窗口的 N 条消息, 这些消息已落 mailbox 不丢.
- **不改 wire format** 核心 — response 再加两个字段, MCP JSON-RPC 允许.
- **不改 poke tool 本身** — 仍是 explicit escape hatch, 调用方若不想等 retry, 继续可手动 poke 直接戳.
- **性能**: 内存 Map 规模很小 (retry 队列最多几十条, 每条一个 setTimeout), 忽略级. 3 轮之后自动 GC.
- **坦白限制**:
  - 10min 以后仍 guard_failed → 彻底 giveup, 消息只在 mailbox.  发送方 LLM 看到 response 后能决定是否降级为 broadcast-reminder 或 human escalation.
  - 若 recipient 的 `tmux_pane_id` 在 retry 期间变了 (re-register 了新 pane), 每次 retry 会**重新从 DB 读**最新 pane_id, 跟得上.
  - recipient 在 retry 窗口期被删除 (unregister), retry tick 时 DB 查不到, 静默跳过并停止后续.
