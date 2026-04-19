## Why

三轮数学 pk e2e (2026-04-18) 暴露出相同的协议问题: LLM 调完 `send_message` / `broadcast` 后**不会自发链式调用 `poke`**, 即使 tool description 里写了 "MAY follow up with poke".  Round 2 kimi 答完忘 poke, Round 3 kimi 答完 + gpt 判完都忘 poke, 都是驱动方 (我) 手动补 poke 才推进.

根因是"tool 设计正确但 LLM 不会主动组合" (memory file `project_fire_and_forget_tools_need_poke_hint.md` 记录过同类问题).  仅在 description 层提示不够 — 需要在**服务端**让 single-recipient 场景**默认 poke**, 把 "正确行为" 变成 opt-out 而非 opt-in.

但裸 auto-poke 不安全: 对端 agent 的输入框可能正在被用户打字 / agent 正在思考, 盲目注入会把用户的输入截断或弄乱对方的进度.  必须加 guard: **目标 pane 要空闲 (≥ 2s 无 pane_tail 变化) 才 poke**, 否则 fallback 为纯 mailbox 投递.

## What Changes

- **MODIFIED**: `src/mcp/send-message.ts` `SendMessageService.send()` 新增 `auto_poke?: boolean` 参数.  默认行为:
  - `to_agent_id` 指定单个 agent → `auto_poke = true` (默认 on)
  - `to_role` 按角色广播 → `auto_poke = true` (默认 on)
  - (broadcast 走独立 tool, 见下)
- **MODIFIED**: `src/mcp/broadcast.ts` `BroadcastService.broadcast()` 新增 `auto_poke?: boolean`, 默认 `false` (避免 mass-poke 刷屏; LLM 判定紧急时显式 opt-in).
- **ADDED**: `src/mcp/poke-guard.ts` — 新模块.  输入 tmux_pane_id, 做两次 `tmux capture-pane` 间隔 `POKE_QUIET_MS` (default 2000, env overridable), 比较文本 hash; 一致 → guard pass; 不一致 → guard fail (对端活动中).
- **MODIFIED**: `src/mcp/tools.ts` — `send_message` 和 `broadcast` tool 的 inputSchema 加 `auto_poke: z.boolean().optional()`; 新返回字段 `poked: boolean`, `poke_skip_reasons?: Array<{ agent_id, reason: 'no_pane' | 'guard_failed' | 'tmux_unavailable' | 'self' }>`.
- **MODIFIED**: `src/mcp/tools.ts` — `send_message` / `broadcast` description 替换掉旧的 "MAY follow up with poke" 劝诱语, 改成"默认自动 poke + 安静 guard; 如果对端 busy 会降级为纯 inbox" 事实描述.
- **ADDED**: `openspec/specs/mailbox/spec.md` 新 Requirements: "Send-message auto-poke default + guard" + "Broadcast auto-poke opt-in".
- **ADDED**: 完整测试: 
  - unit: poke-guard 的 hash 比较 + env override
  - integration: send_message auto_poke path 在 tmux mock 下的 guard pass / guard fail / no_pane / cross-team 分支
  - regression: broadcast 默认不 poke, 显式 opt-in 会逐个 guard
- **MODIFIED**: `docs/configs/README.md` 加一节 "Auto-poke on send" 说明新默认行为 + guard 机制 + ENV `POKE_QUIET_MS`.

## Capabilities

### Modified Capabilities

- `mailbox`: 加 send_message 默认 auto_poke + guard + broadcast 的 auto_poke opt-in.  其他 (message_sent event, mailbox 落盘, unknown_recipient 错误分类等) 不变.

### New Capabilities

(无)

## Impact

- **不改 DB schema** (auto_poke 是参数层, 不落盘).
- **不改 wire format** 核心 — 只在 response 尾部多 2 个字段 (poked, poke_skip_reasons), 老客户端解析时可忽略.
- **不改 poke tool 本身** — 继续作为"我知道要 poke"的显式入口, 不走 guard (explicit > implicit).
- **性能**: auto_poke 默认 on 会让 send_message 同步等 `POKE_QUIET_MS` (2s).  这在绝大多数"agent A 发完消息等 agent B 处理"的场景下可以接受, 因为 A 本来也要等回音.  测试时用 env 把 quiet 调到 100ms 避免慢测.
- **下游**: 
  - Claude Code / opencode / codex CLI 端无需改动 — 它们本来就只是调用 MCP tool.
  - LLM 行为层面: 不再需要 LLM "知道" 调 poke, 发单发 / role 发自动带.
  - broadcast 要 mass poke 时 LLM 必须显式 `auto_poke: true`, 避免误 spam.
- **坦白限制**: guard 用 2 秒 hash 对比判"空闲", 可能误判:
  - 假阳 (判为空闲但其实对端刚按键完): 几率很低, 只要 2s 内没再按键就 OK, poke 也不会把 caret 位置拉坏.
  - 假阴 (判为 busy 但其实空闲): 对端屏幕有动画 (如 spinner) 时 hash 变化 → skip poke → 降级纯 inbox, 正确但错过了.  这是可接受的保守行为.
