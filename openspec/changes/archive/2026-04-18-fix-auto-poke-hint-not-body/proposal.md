## Why

Live E2E (2026-04-19) 暴露: `send_message` 和 `broadcast` 的内部 auto-poke 路径把**消息 body** 当 poke prompt 直接注入对端 tmux pane, 等于绕过 mailbox 直接"伪造用户输入"给对方 LLM.

典型案例:
- 我 (opus) 给 kimi 发 `send_message({body: "帮忙测试 broadcast auto-poke 新功能. kimi 你好..."})`, kimi 的 pane 收到完整 body 作为"用户指令", kimi 直接按 body 执行广播.
- kimi 想汇报"retry 有 bug"的发现, 也走相同路径, 我 (opus) 的 pane 收到完整"bug 报告"作为"用户发言", 我误以为是用户提 bug 并开始分析.

2 步引用链路完全绕开了"Mailbox + get_inbox"契约.

Commit `2ec2e7c fix(mcp): clarify poke is a wake-up hint, not a content channel` (2026-04-19) 只修了 `poke` 的 **tool description** (劝 LLM 直接调 poke 时别把 body 当 prompt), **没有修 `autoPokeImpl`** — 内部 auto-poke 路径依然把 `args.body` 作为 poke prompt. 本 change 补上这块缺口.

## What Changes

- **MODIFIED**: `src/mcp/tools.ts` `autoPokeImpl` 的 poke 调用.
  - Before: `await poke(..., { target_agent_id, prompt: args.body })`
  - After: 查 agents repo 拿 sender 的 `display_name`, 构造短 hint `"新邮件 from {display_name} ({agent_id}), 请调 get_inbox 查看"`, 作为 poke prompt. `args.body` 不参与 prompt.
  - Fallback: `display_name` 为 null/空 → 用 `agent_id` 的前 8 位 (短 hash) 代替, hint 仍然短.
  - 长度保证: 整条 hint 不超过 180 字符 (poke description 约定 < 200).
- **ADDED**: `tests/auto-poke-hint-format.test.ts` — 3 个 unit-level 场景验证:
  1. send_message 单发时 pokeFn 收到的 prompt 是 hint 格式 (含 "新邮件", "get_inbox"), **不** 含 body 原文.
  2. broadcast 时所有 recipient 的 pokeFn 收到的 prompt 都是 hint, 不含 body.
  3. display_name 为 null 时 hint 正确降级到 `agent_id[:8]`.
- **MODIFIED**: `src/mcp/tools.ts` `send_message` 和 `broadcast` 两个 tool 的 description, 补一句 "auto-poke 只注入 `新邮件 from X` 短提醒, 消息 body 只通过 mailbox + get_inbox 取用".
- **MODIFIED**: `tests/tool-descriptions-poke-hint.test.ts` — 新增断言 send_message / broadcast description 含 "only injects a short wake-up hint" 类似措辞, 防止未来反向回退.
- **MODIFIED**: `openspec/specs/mailbox/spec.md` 通过 delta 新增 Requirement "Auto-poke prompt is a wake-up hint, not the message body".
- **MODIFIED**: `docs/configs/README.md` 在 "Auto-poke on send" 节补一段说明 hint 格式 + 不再注入 body.

## Capabilities

### Modified Capabilities

- `mailbox`:
  - ADDED Requirement: `Auto-poke prompt is a wake-up hint, not the message body` — 约束 `autoPokeImpl` 构造的 poke prompt 只含 sender + "调 get_inbox", 绝不含消息 body.

### New Capabilities

(无)

## Impact

- **不改 DB schema**.
- **不改 wire format**: `send_message` / `broadcast` 的 response 结构不变; 客户端看不到区别.
- **行为变化**:
  - 对端 LLM 收到的 poke prompt 从"完整 body"变为"新邮件 from X, 调 get_inbox". 它需要先调 `get_inbox` 才能看 body, 与"Mailbox 是唯一内容通道"契约完全一致.
  - 极小 DB 开销: 每次 auto-poke 多一次 `agents.findById(fromAgentId)` 查询 (已有索引, <1ms).
- **测试影响**: 现有 poke-retry 和 auto-poke-fanout 测试用 stub pokeFn, 不做 prompt 断言 — 不需改. 新增的 hint-format 测试单独跑.
- **回滚路径**: 一键 revert commit 即可回到旧行为 (本 change 是纯参数构造变化, 不引入新状态).

## 与其他 change 的关系

- **正交**: 不依赖也不阻塞 `add-auto-poke-on-send` / `add-auto-poke-on-broadcast`. 本 change 可以独立 archive.
- **历史契合**: 兑现 commit `2ec2e7c` 的设计意图 ("poke is a wake-up hint, not a content channel"), 把"外部 poke 调用劝阻"延伸到"内部 auto-poke 强制".
