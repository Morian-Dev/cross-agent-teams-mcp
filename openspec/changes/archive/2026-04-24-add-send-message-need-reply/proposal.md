## Why

agent 之间通过 `send_message` 协作时, 发送方是否期待接收方回复目前只能靠正文表达。  这会导致发送方以为需要回复, 接收方却把消息当作无需回复的通知处理。

## What Changes

- `send_message` 新增可选参数 `need_reply`, 默认值为 `true`。
- 调用方可以显式传 `need_reply:false`, 表示这条消息是 FYI/通知类消息, 默认不期待接收方回复。
- `messages` 表持久化 `need_reply`, `get_inbox` 返回每条消息的 `need_reply`。
- `broadcast` 和 `broadcast_to_role` 写入的消息显式标记为 `need_reply:false`, 避免多收件人消息默认要求每个接收方回复。
- 项目尚未上线, 不处理历史消息兼容或数据迁移语义。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `mailbox`: `send_message` 消息携带回复期待语义, inbox 读取方能直接看到该约定。

## Impact

- 影响 MCP tool schema 和 description: `send_message` 接受 `need_reply?: boolean`。
- 影响存储 schema: `messages` 新增 `need_reply` 字段。
- 影响消息写入路径: `send_message`, `broadcast`, `broadcast_to_role`。
- 影响 inbox 查询和返回类型: `get_inbox` 返回 `need_reply`。
- 影响测试: schema 校验, 持久化默认值/显式值, inbox 返回字段。
