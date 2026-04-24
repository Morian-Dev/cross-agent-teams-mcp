## Context

`send_message` 当前只表达投递和唤醒语义: 消息会进入 mailbox, `auto_poke` 决定是否用 quiet-guard 唤醒接收方。  但它不表达协作语义, 即发送方是否期待接收方回复。  agent 读取 inbox 时只能从正文猜测, 容易把需要回复的消息当成通知, 或把通知类消息当成需要回复。

项目尚未上线, 本次不需要兼容历史消息。  可以直接更新 `messages` 表契约, 并让所有写入路径显式写入 `need_reply`。

## Goals / Non-Goals

**Goals:**

- `send_message` 支持 `need_reply?: boolean`, 默认 `true`。
- `need_reply` 持久化到 `messages` 表, 并通过 `get_inbox` 返回给接收方。
- `broadcast` 和 `broadcast_to_role` 写入 `need_reply:false`, 避免多收件人消息默认要求回复。
- tool description 明确说明 `need_reply:false` 用于无需回复的 FYI/通知消息。

**Non-Goals:**

- 不实现 reply thread, ack, 超时提醒, 或强制回复检查。
- 不为历史消息提供迁移语义。
- 不改变 `auto_poke` 的唤醒行为。

## Decisions

1. 使用 `need_reply` 作为 MCP 参数名和消息字段名。

   现有参数采用 snake_case, 例如 `to_agent_id`, `to_team`, `auto_poke`。  `need_reply` 与现有风格一致, 也避免 `need-reply` 在 TypeScript 类型和 JSON schema 中形成不一致。

2. `send_message` 省略 `need_reply` 时默认 `true`。

   私聊默认是一次面向特定 agent 的协作请求。  如果发送方不期待回复, 必须显式传 `need_reply:false`, 这样协议中的沉默语义是有意为之, 不是遗漏。

3. `broadcast` 和 `broadcast_to_role` 显式写入 `need_reply:false`。

   多收件人 fan-out 默认要求每个接收方回复会产生噪音。  这些工具本次不暴露 `need_reply` 参数, 只保证写入的消息不会被 inbox 消费方误读为必须回复。

4. `need_reply` 是可见协议, 不是强制机制。

   当前 mailbox 没有 reply thread 或 message ack 模型。  因此本次只保证发送方能表达期待, 接收方能看到期待。  后续如果需要未回复检测, 可以在这个字段之上新增 thread/ack 能力。

## Risks / Trade-offs

- [Risk] 接收方 agent 仍可能忽略 `need_reply`。  → Mitigation: tool description 和 inbox 返回字段把约定显式化, 后续可在 agent prompt/协作规范中进一步强化。
- [Risk] 广播消息无法表达“所有人都需要回复”。  → Mitigation: 本次需求来自 `send_message` 的 1→1 误解, fan-out 回复语义更复杂, 保持非目标范围。
- [Risk] 表结构变化触及多个 SQL insert。  → Mitigation: 为 schema, send_message 默认/显式值, broadcast 默认值, get_inbox 返回字段分别加测试。
