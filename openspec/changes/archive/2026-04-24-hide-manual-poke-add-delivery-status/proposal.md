## Why

面向 agent 暴露的手动 `poke` 给了调用方一条绕过 quiet-guard 和 retry 策略的直接打断路径。  在真实 xats 使用中, 这会鼓励 agent 在 auto-poke 已成功或已排队重试后继续重复手动 poke, 所以唤醒契约应该从“agent 可以主动打断”调整为“agent 可以观察投递状态”。

## What Changes

- **BREAKING**: 从普通 agent 的 `list_tools` / 调用面移除公开 MCP `poke` 工具。
- 保留 daemon 内部 `poke()` transport primitive, 继续供 auto-poke, channel wake, opencode, Codex app-server, tmux delivery 使用。
- 为已发送消息新增可查询的 delivery status, 让发送方能看到 auto-poke 已投递, 正在重试, 已跳过, 或重试耗尽。
- 记录后台 auto-poke retry 成功和重试耗尽结果。
- 更新 `task_add` 说明, 不再建议手动 `poke`, 也不增加 `notify_agent_id` 这类定向通知替代品。

## Capabilities

### New Capabilities

### Modified Capabilities
- `agent-interrupts`: 移除 agent 直接可见的 `poke` 工具, 但 daemon 内部唤醒投递能力继续可用。
- `mailbox`: 消息发送记录并暴露 auto-poke delivery state, 供发送方查询。

## Impact

- MCP tool registry 不再向普通 agent 暴露 `poke`。
- `send_message`, `broadcast`, `broadcast_to_role`, auto-poke fan-out, retry 代码需要写入投递状态。
- 依赖手动 `poke` 可见性的测试和文档需要更新。
