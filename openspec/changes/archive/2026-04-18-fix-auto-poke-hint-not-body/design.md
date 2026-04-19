## Context

`send_message` / `broadcast` 在 `add-auto-poke-on-send` 和 `add-auto-poke-on-broadcast` 两个 change 之后, 默认自动调用内部 `autoPokeImpl` 对收件人 tmux pane 做 quiet-guard + poke. 当前实现 (`src/mcp/tools.ts:41-53`) 把消息 body 原文作为 poke prompt:

```ts
const autoPokeImpl = async (args) => {
  const res = await poke(
    { db, callerAgentId: args.fromAgentId },
    { target_agent_id: args.targetAgentId, prompt: args.body }  // ← 问题
  )
  ...
}
```

Commit `2ec2e7c` 已将 `poke` tool 的外部调用约定为"SHORT wake-up hint (<200), NOT a content channel", 并要求"content belongs in send_message". 但内部 auto-poke 路径没跟上, 结果: **LLM 调 send_message/broadcast 的 body, 被当作 poke prompt 注入对方 pane**, 与 commit 原意自相矛盾.

E2E 验证复现: 我 (opus) 给 kimi 发 send_message 请它广播, kimi 的 pane 直接收到我的完整指示作为"用户输入"; kimi 给我回"发现 bug"的分析, 我的 pane 又被完整注入作为"用户发言". 两步 mailbox 契约全部绕过.

## Goals / Non-Goals

**Goals**:

- 修 `autoPokeImpl`, 使 poke prompt 只含 sender 标识 + "调 get_inbox" 短提醒, 绝不含 body.
- Hint 格式固定为方案 A: `"新邮件 from {display_name} ({agent_id}), 请调 get_inbox 查看"`.
- `display_name` 为 null/空时降级为 `agent_id` 前 8 位短 hash.
- 单元测试验证 hint 构造与 body 隔离.
- Mailbox spec 新加 Requirement 明文约束该行为.
- Tool description 补充说明 (给 LLM 看) "auto-poke 是短提醒, 不是内容传递".

**Non-Goals**:

- 不改 poke tool 本身 (外部直接调 poke 已由 `2ec2e7c` 劝阻).
- 不改 Mailbox 落盘 / get_inbox / event outbox 行为.
- 不改 retry-backoff 逻辑.
- 不改 quiet-guard 逻辑 (`POKE_QUIET_MS`).
- 不加"可配置 hint 模板" — 格式固定单一, 简化决策.
- 不加 subject 预览到 hint — 信息最少化, 绝对不透 body 任何字节.
- 不做"去重/抑制连续相同 hint" — N 条消息 = N 个 hint, 每次 LLM 决定"要不要立刻 get_inbox". 冗余成本低, 比"漏 hint"安全.

## Decisions

### Decision 1: Hint 格式固定 A

**选择**: `"新邮件 from {display_name} ({agent_id_short}), 请调 get_inbox 查看"`.

`agent_id_short` = `display_name` 有效时用完整 agent_id; 否则用 `agent_id[:8]`.

**理由**:
- 最少信息化: 不泄露 body/subject 任何字节.
- sender 信息足以让接收 LLM 判断"是否需要立刻读". 如"是我的 lead", "是某个 agent 在做状态汇报, 可以晚点读".
- 中文固定短语便于未来 grep 定位该路径来源.
- 总长度 30-80 字节, 远低于 200 char 上限.

**替代被驳回**:
- B: 带 subject 前 40 字 → 仍然泄露用户意图可能敏感; 测试里断言"不含 body" 的断言范围模糊.
- C: 纯 "有新邮件" → LLM 无法判断重要性, 可能积累 N 条不处理.

### Decision 2: 降级策略: display_name → agent_id[:8]

**选择**: `agents.findById(fromAgentId)?.display_name || fromAgentId.slice(0, 8)`.

**理由**:
- 现实中 agent_id 是 UUID, 完整 36 字符过长. 降级用前 8 位保持 hint 紧凑.
- 找不到 agent (理论不该发生, 因为 fromAgentId 来自已 register 的 caller) → 用前 8 位代替, 不抛异常.

**替代被驳回**: "找不到就直接 throw" — 会把一个内部一致性问题暴露成 send_message 失败, 用户体验差; 降级更保守.

### Decision 3: 单次 DB 查询做 display_name lookup, 不引缓存

**选择**: 每次 `autoPokeImpl` 调用走一次 `agents.findById(fromAgentId)`.

**理由**:
- sqlite + 主键索引查询 <1ms, N recipients 情况下多 N 次 (或 1 次 + 共享) 都可接受.
- 无缓存 = 无一致性问题 (display_name 更新立即生效).
- 当前版本有 fan-out `Promise.all` 并行, 可选优化是"sender lookup 提到 fan-out 入口外做 1 次", 留到未来如果真是瓶颈.

**本 change 的实现细节**: 在 `autoPokeImpl` 外层闭包 (createMcpServer scope) 拿 `agents` repo ref, 每次 autoPokeImpl 内 `agents.findById(args.fromAgentId)` 一次.

**替代被驳回**:
- 在 fan-out 入口拿 1 次然后透传: 需要改 `AutoPokeFn` 签名加 `senderDisplayName` 字段, 扩散改动面.
- 内存缓存: 引入失效窗口问题, 不值得为 <1ms 查询加缓存.

### Decision 4: 两条路径 (初始 + retry) 自动一起被修

`autoPokeImpl` 是 send_message / broadcast / poke-retry 三方共享的 `AutoPokeFn`. 改一处覆盖三处. 无需动 poke-retry.ts 或 auto-poke-fanout.ts.

**验证**: poke-retry 的 `ctx.pokeFn` 拿的是 `auto-poke-fanout.ts:97` 包装的 outer pokeFn, outer pokeFn 就是 `autoPokeImpl`. 链路确认无缝.

### Decision 5: 测试策略: unit 级 pokeFn mock, 不做 tmux 真实注入

**选择**: 在 `tests/auto-poke-hint-format.test.ts` 里 mock `poke.ts` 导出的 `poke` 函数 (顶层 import 拦截), 断言调用参数 `prompt` 的内容.

**理由**:
- autoPokeImpl 直接调用 `poke(...)`, mock 它就能断言 prompt 字符串.
- 不需要 tmux 模拟器, 减少测试 flaky.

**替代被驳回**: 真实 tmux capture-pane → 新增 shelling out, 慢, CI 不稳.

### Decision 6: tool description 加一句, 不改参数 schema

**选择**: `send_message` 和 `broadcast` 的 description 末尾加:

> "Auto-poke only injects a SHORT wake-up hint (format: `新邮件 from {sender}, 请调 get_inbox 查看`). The message body is NEVER injected into the recipient's pane — callers retrieve bodies via `get_inbox`."

**理由**: 与 commit 2ec2e7c 的 poke description 改动呼应, 让 LLM 读 tool 时就知道"body 只通过 mailbox 流动".

**替代被驳回**: 加新参数让调用方控制 hint 格式 — YAGNI, 固定格式够用.

## Risks / Trade-offs

- **向后兼容性**: 使用旧版 dist 的客户端 (包括已运行的 daemon 进程) 不受影响; 升级后一次 daemon 重启即可. 本次仓库已验证 dist/cli.js 可通过 `pnpm run build` 重新构建.
- **LLM 行为变化**: 升级后 LLM 调 send_message 不再能"搭车"把指示直接推给对方 pane. LLM 需要显式知道"消息要对方主动读". 这恰好是我们想要的行为.
- **可能的误操作**: 若 LLM 确实想"紧急 push 指令", 它可以直接调 `poke` tool (外部调用) 传一个 short prompt. 这条路径保留, 且 `2ec2e7c` 的 description 已劝阻误用.
- **hint 信息最少化 vs 有用性**: 只带 sender 不带 subject 意味着 LLM 收到"新邮件 from kimi" 时无法判断优先级. 接受这个代价, 换"绝对不泄露 body 字节"的简单安全性.

## Migration Plan

1. 代码合并后重 build: `pnpm run build`.
2. 重启 daemon (新 `autoPokeImpl` 生效).
3. 验证: 随便发一个 `send_message` 给另一个 agent, 对端 pane 输入框应只收到 `新邮件 from {sender}, 请调 get_inbox 查看`, 不含 body 任何字节.
4. 本 change 与 `add-auto-poke-on-send` / `add-auto-poke-on-broadcast` archive 顺序无关, 独立执行.

## Open Questions

(无)
