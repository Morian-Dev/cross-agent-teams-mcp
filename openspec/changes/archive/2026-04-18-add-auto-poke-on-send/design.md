# Design — add-auto-poke-on-send

## Context

- `src/mcp/send-message.ts` 是纯 mailbox 落盘, 无副作用.
- `src/mcp/broadcast.ts` 是 team-wide 版本, 同样纯 mailbox.
- `src/mcp/poke.ts` 是独立 tool, 做 tmux paste-buffer + send-keys, 目前无 cooldown / 无 quiet-guard.
- `src/daemon/tmux-cli.ts` 已导出 `capturePaneTail`, 可复用.
- 三轮数学 pk 证实: LLM 光靠 tool description 的 "MAY poke" 不会链式调用; 需把 "发完 poke" 变成服务端默认.

## Goals

1. 让单发 / role 发 **默认** 触发 poke, LLM 无需额外 tool call.
2. 用最小 guard 避免打扰进行中的对端 (盯 pane_tail 2s 静默).
3. broadcast 保持 opt-in, 避免 mass-poke 刷屏.
4. 给 LLM 足够 observable 信息 (response 里说 poked yes/no + 为啥没 poke), 让它能在必要时补 follow-up.

## Non-Goals

- **Don't** 做 per-agent rate-limit / 全局 rate-limit (当前规模不需要).
- **Don't** 改 poke tool 自身 (显式 poke 走 explicit-bypass-guard 语义, 保留作为 escape hatch).
- **Don't** 做排队等 guard 过的功能 (proposal 确认: fallback 为纯 inbox, 让 caller 判断是否重试).
- **Don't** 改 tool 的 wire protocol / JSON-RPC 结构, 只在 response body 加字段.

## Key Decisions

### 1. Default matrix (哪些场景默认 on)

| caller 参数 | auto_poke 默认 | 为什么 |
|---|---|---|
| `to_agent_id` 给单个 agent | **true** | 单发几乎总是希望对方立即处理, 这是 pk/协作/紧急通知典型模式 |
| `to_role` 按角色发 (通常 1-3 人) | **true** | 按角色发一般是找"某类专家", 规模可控 |
| `broadcast` tool | **false** | 全团队, 动辄十几人, 默认 poke 会同时戳所有 pane 刷屏 |

显式 `auto_poke: boolean` 总是 override 默认值.

### 2. Guard: 2 秒 pane_tail hash 静默检测

**Decision**: 每个要 poke 的 target 单独做 guard — `capturePaneTail` (8 lines) → hash → 等 `POKE_QUIET_MS` → 再 capturePaneTail hash → 对比.  一致 → fire poke, 不一致 → skip + 记 reason.

**Rationale**:
- `pane_tail` 文本稳定的唯一场景就是 "光标在 prompt 处, 没在打字, 没在跑命令".
- 简单 hash 对比是无状态的, 不需要 daemon 维护"每个 pane 上次活跃时间".
- 2s 对 LLM coding agent 的输出节奏 (通常 token 流式, 屏幕一直在变) 足够区分忙 / 闲.

**Rejected**:
- **tmux format `#{pane_last_activity}`**: tmux 默认不 track 这个指标 (需要 activity-action monitor-activity 配置), 不可靠.
- **per-pane 上次 poke 时间戳**: 只防连续 poke, 不防用户正在打字.
- **看 `pane_current_command`**: 只反映最外层进程 (node / claude / codex), 不告诉我们是否 idle.

### 3. Fallback 策略: guard 失败 → 降级为纯 mailbox

**Decision**: guard fail / no_pane / tmux unavailable / self-target / cross-team (不应到这里但防御性编码) → 消息**照常入 mailbox**, response 的 `poked=false` + `poke_skip_reasons[]` 说明每个跳过的 recipient 的原因.

**Rationale**:
- 消息绝对不能丢 (mailbox 是 SOT).
- LLM 看到 `poked=false, reasons=[{agent_id: X, reason: 'guard_failed'}]` 可自行决定是过会儿再 poke 还是让对方自己 pull.
- 比"抛 error 整个 send 失败"安全得多.

### 4. ENV override `POKE_QUIET_MS`

**Decision**: `POKE_QUIET_MS` 环境变量可覆盖默认 2000ms, 正整数才生效.  用于:
- 测试 (设 100ms 让 vitest 不拖)
- 运维调参 (如果发现 2s 在某些场景太短 / 太长)

### 5. Parallel guards for multi-recipient

**Decision**: `to_role` 发多个 / broadcast opt-in 多个时, 所有 target 的 guard **并行**跑 (Promise.all), 不串行.  上限: 20 个并行 (超出部分也串也行, 当前规模不触发).

**Rationale**:
- caller 最多等 1×POKE_QUIET_MS (2s), 不是 N×2s.
- 20 个并行 tmux capture 对 CPU 忽略不计.

### 6. poke tool 保留, 不走 guard

**Decision**: `poke` MCP tool 继续存在, 继续**不**做 guard — 即使 target 正在打字也会 paste-buffer.

**Rationale**:
- poke 是"我明确知道要戳对方, 即使对方在忙"的 explicit 入口, 主要用于 workflow 驱动 (比如判分官喊各个选手).
- 如果 auto_poke 不够用 (比如 guard 一直 fail 对方一直忙), LLM 可以 fallback 到手动 poke, 这是 safety escape hatch.
- 给 poke 加 guard 会让"我不管对方状态, 强制唤醒"的语义消失 — 那就失去这个 tool 的价值了.

### 7. Response shape

```ts
// send_message 返回
{
  message_id: string
  event_id: number
  recipients: string[]       // 原有
  poked: boolean             // 新增: 是否**任何**一个 recipient 被 poke 了
  poke_skip_reasons?: Array<{ agent_id: string; reason: 'no_pane' | 'guard_failed' | 'tmux_unavailable' | 'self' }>
}
```

`poked: true` 代表"至少一个 recipient 被 poke 了"; `poke_skip_reasons` 列出被跳过的每个 recipient 的具体原因.  如果 `auto_poke: false` 或 broadcast 默认, `poked=false`, `poke_skip_reasons=undefined`.

### 8. 和 poke_idiom 文档的关系

`docs/configs/README.md` 的 "send + poke idiom" 一节要更新 (或标记 obsolete) — 现在 idiom 是"send_message 会自动 poke, 你只在 broadcast 或需要跳过 guard 时才手动 poke".

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| guard 2s 误判对端 busy (屏幕有 spinner 等动画) | 中 | LLM 跟 follow-up 走, 没灾难 | fallback 纯 mailbox; LLM response 看到 reason 可补 |
| auto_poke 让 send_message 响应时间 +2s | 中 | 调用方 LLM 等待感变强 | 说明文档 + ENV override; 大部分 sender 本来就要等回音 |
| LLM 看到 response 里 `poked:true` 以为自己已经交接, 结果对方正忙于其他事 | 低 | 语义错判 | 新 description 里写明 "poked 只代表注入成功, 不代表对方处理了" |
| 并行 tmux capture 对 tmux server 有无压力 | 低 | CPU 可忽略 | 上限 20 parallel |
| 旧客户端遇到新字段 `poked` 崩 | 极低 | 兼容问题 | 额外字段, MCP JSON-RPC 按 spec 忽略未知; 测过了 |

## Alternatives Considered

1. **不改 server, 只升级 tool description 到 imperative "MUST poke"**: 已证实不够 (gpt/kimi 还是会忘).
2. **发 message + 返回一个 "next-action hint" JSON, LLM 必须再调**: 加一次 tool-call 往返, 慢; 而且 LLM 仍可能忽略 hint.
3. **poke 作为 internal call, 不暴露为 tool**: 破坏现有 "explicit poke" 语义, kimi/gpt 已经 habit 了.
4. **Per-agent rate-limit (例如 30s 内同 pane 最多 poke 一次)**: 治的是刷屏, 不治"正在打字被打断"; 且会让真正紧急多发失效.

## Rollout

- 零 migration (纯参数 + 默认值变更).
- Daemon 重启即可.
- 更新 docs "Auto-poke on send" + obsolete 掉 "send + poke idiom".
- 监控: 看 response 里 `poke_skip_reasons.reason` 分布, 如果 `guard_failed` 占比过高说明 2s 窗口需要调大.
