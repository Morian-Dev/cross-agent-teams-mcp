# Design — add-auto-poke-retry-backoff

## Context

- `src/mcp/auto-poke-fanout.ts` 已支持 single-shot guard + poke, guard_failed 的 recipient 现在只能靠 caller 手动补 poke.
- 数学 pk + 验证实验: LLM 不会自发补 poke; 即便 response 有 `guard_failed` reason.
- Claude Code / opencode 这种 TUI-heavy agent 几乎"永远忙", 直接 guard 总 fail.
- 现成模块可复用: `runQuietGuard` (poke-guard.ts), `capturePaneTail` (tmux-cli.ts), `touch` (agents-repo.ts).

## Goals

1. guard_failed 不再是终结; daemon 主动再等再戳.
2. 不要无限重试 (bounded: 3 次).
3. 对方自己上来时立刻停 (polite, 不重复打扰).
4. 用 in-memory 结构, 最小代码量, 不动 DB schema.

## Non-Goals

- **Don't** 做跨进程持久化 retry 队列.  内存即可, 丢失可以接受 (消息在 mailbox).
- **Don't** 动 poke tool 本身 (继续 explicit / 无 guard).
- **Don't** 改 guard 逻辑 (怎么判"忙"不在本 change 范围; 本 change 只是给 guard_failed 一条重试通道).
- **Don't** 做"指数退避动态参数".  `[30, 180, 600]` 秒硬编码, 不搞 env override (除非 test 需要 — 测试用 fake timers 足够, 不用 env).

## Key Decisions

### 1. 固定退避序列 `[30, 180, 600]` 秒

**Decision**: 三次重试, 延迟硬编码为 30 秒、3 分钟、10 分钟.

**Rationale**:
- 30s: 覆盖"短工作中断后立刻空闲"的常见窗口.
- 3min: 覆盖"在思考 / 跑单个工具 call" 的中等忙碌.
- 10min: 最后托底, 再不戳就放弃, 免得拖很久.
- 总时长 ≈ 13.5 min, 足够 cover 一次 LLM 的长回合.  超过就可能对方真忘了, 靠 sender LLM 补一次 broadcast / ping 也 OK.

**Rejected**:
- ENV 可调: 本阶段过设计.  如果用户发现序列不合适, 下一次 change 加.
- 指数退避 `2ⁿ`: 30s → 60s → 120s → 240s… 累计 7.5 min 不如 30+180+600.

### 2. 状态内存化: `Map<string, { timer, attempt, agentId, messageId, fromAgentId, body, team, sentAt }>`

**Decision**: key = `${messageId}:${recipientAgentId}`.  value 存当前 schedule handle + 上下文.

**Rationale**:
- 2s guard 完成后 send_message 就返回, retry 是后台工作, caller 不等.
- daemon 重启 retry 丢失 — acceptable: 消息已在 mailbox; sender 看 response 只知道 "曾经排了", 是否落地由日志 / 后续观察决定.
- 对端如果重启也不影响: retry 回调会重新从 DB 查 pane_id, 查不到就静默停.

**Rejected**:
- SQLite 表: 实现量重 (schema migration, polling, 重启重建 setTimeout), 对 MVP 不值.

### 3. 取消条件: recipient 的 `last_seen_at` > `sentAt` → 静默跳过后续 retry

**Decision**: 每次 retry tick 先查 `agents.findById(recipientAgentId).last_seen_at`, 比较 `sentAt` (原 message 的 sent_at).  前者更新意味着对方期间做过任何 MCP 调用 (touch_if_registered 会刷新), 视为"自己上来了", 停止后续.

**Rationale**:
- 现有 `agents_repo.touch(agentId)` 在每个 tool 调用后运行 (见 `tools.ts run()`), 是最可靠的 "agent is online / working" 信号.
- 不引入额外"read_at" 概念 — "对方 last_seen 变新" 已经 strictly better than "对方读了这条消息", 因为它覆盖了"对方发了其他消息 / claim 了 task 但还没读 inbox"的情况.

**Rejected**:
- "recipient 调过 get_inbox 才停": 要存 cursor per (agent, message), 复杂且不灵通.
- "从不提前停, 总是跑完 3 轮": 会在对方正常工作时重复戳, 刷屏.

### 4. retry 每次重跑完整 guard; 不降低 guard 标准

**Decision**: retry 的 tick 就是 "wait N seconds" → `runQuietGuard(pane)` → pass 就 poke, fail 就排下一轮.

**Rationale**:
- guard 是"我不想打扰正在打字的对方"; 30s 后如果还在打字, 继续不打扰是对的.
- 一致的 guard 语义让 retry 不会比"及时 poke" 更 aggressive (除了时间间隔).

### 5. no_pane / self / tmux_unavailable 不进 retry

**Decision**: 这三类 reason 不排 retry.

**Rationale**:
- no_pane: 重试 N 次也解决不了对方没 pane 注册.  解决方案是 recipient 自己 re-register 带 pane_id, 然后自己 get_inbox.
- self: 完全不应该发生 (UI 误操作), 重试无意义.
- tmux_unavailable: 整个 host 没 tmux, 10min 后还是没 tmux.

**只针对 `guard_failed` retry** — "暂时忙" 是唯一值得等的状态.

### 6. Response shape

```ts
// send_message / broadcast
{
  message_id, event_id, recipients,
  poked: boolean,
  poke_skip_reasons?: Array<{ agent_id, reason }>,   // 原有
  retry_scheduled: boolean,                           // 新: 是否至少 1 个 recipient 进了 retry
  retry_delays_s?: number[]                           // 新: 排队时用的序列 (固定 [30,180,600])
}
```

若 `retry_scheduled=false` → `retry_delays_s` 可以 `undefined` (省字节, 符合 optional 语义).

### 7. Shutdown cleanup

**Decision**: daemon 的 `onClose` hook 调 `clearAllRetries()`, 清所有 setTimeout handles.

**Rationale**:
- 防 vitest / production shutdown 后 timer 还在发 guard, 导致 "tmux server not found" 错误日志或 process 不干净退出.
- 一行实现 (`for (const [, v] of retryMap) clearTimeout(v.timer); retryMap.clear()`).

### 8. 不 bubble 成功的 retry 给 caller

**Decision**: retry 成功 poke 了, 不通知 caller (caller 不 block, 早就 return 了).

**Rationale**:
- caller 的 send_message 早就返回, 已经下一轮 turn; 回补通知 = 副作用消息, 污染 inbox.
- recipient 被 poke 后会自己起反应; caller 观察响应链即可.

**Alternative considered**: 写一条 `events` 表行 (event_type='poke_retried') 让 SSE 订阅方看见.  推荐 defer 到有需要再做.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| setTimeout handle 泄露 (recipient 在 retry 窗口中被 delete) | 中 | process 保持 extra TimerMgr 引用 | `scheduleRetry` 启动前会查 recipient 存在; 不存在不排; retry tick 首先再次查 DB, 找不到静默 return |
| 同 recipient 短时间内 100 条 message guard_failed → 100 × 3 = 300 个定时器 | 低 (典型场景) | 内存轻量占用 | Map lookup O(1), 300 timer 无压力; 若真成高频流量, 后续加 "per-recipient 最近 N min 最多 K retry 队列" limit |
| last_seen_at 在 retry 窗口内同步更新但 recipient 没实际读 inbox | 中 | 停早了, 消息只在 mailbox | mailbox 是 SOT, 对方下次 get_inbox 必然拉; 用户视角等效 "延迟到对方下一次 turn" |
| 多 sender 竞争同一 recipient | 低 | 多条 retry 并排 | 每条 msg 独立 key, 互不影响 |
| daemon crash 丢 retry | 低 (本地 MVP) | 最多 3 轮 retry 丢失 | 消息已落库; sender 可手动补 `poke` |

## Alternatives Considered

1. **guard 改算法 (忽略光标行 / 多次采样)**: 本 change scope 外; 复杂; 易不稳定.
2. **response return 增加 "followup_poke_token"，让 caller 决定是否启动**: 把复杂度推给 LLM.  前面的数学 pk 证实 LLM 不会用.
3. **broadcast 全体重试**: broadcast 本来就是 auto_poke:false 默认, 对它设 retry 没意义 (需要 caller 主动打开 auto_poke).  若 caller 打开, retry 行为自动 apply per-recipient, 无需特殊对待.
4. **持久化 retry 到 DB**: 过设计, 留作未来优化.

## Rollout

- 零 migration.
- daemon 重启即生效.
- 文档 `docs/configs/README.md` "Auto-poke on send" 节追加 "Retry on guard_failed" 子段.
- 观察: 如果 retry 命中率过低 (> 50% 都 3 轮 fail) 说明 guard 算法本身需要进一步迭代.
