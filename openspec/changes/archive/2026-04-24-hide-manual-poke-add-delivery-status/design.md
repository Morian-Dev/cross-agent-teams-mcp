## Context

`send_message`, `broadcast`, `broadcast_to_role` 已经默认持久化 mailbox row 并 auto-poke recipient。  它们会同步返回 `poked`, skip reason, retry scheduling, 但后台 retry 结果仍是静默副作用。  公开 `poke` MCP tool 仍然是一条无 quiet-guard 的手动打断路径, `task_add` 文档也还在引导 agent 使用这条路径。

## Goals / Non-Goals

**Goals:**
- 移除 agent 对手动 `poke` 的公开访问。
- 保留 daemon 内部 auto-poke 和 retry 流程使用的 wake delivery。
- 为每个 message recipient 持久化发送方可查询的 auto-poke delivery status。
- 记录即时结果, retry 成功, retry 取消, retry 耗尽。
- 保持 `task_add` 为纯 task-list 操作, 不增加 `notify_agent_id` 或任何定向通知替代品。

**Non-Goals:**
- 不新增把 delivery status 主动推回发送方的机制。
- 不新增 task assignment 或 targeted task notification 功能。
- 不改变 mailbox 持久化语义。
- 不改变 auto-poke hint 格式。

## Decisions

1. 隐藏工具, 保留 primitive。

   从公开 MCP tool registry 移除 `server.registerTool('poke', ...)`。  保留 `src/mcp/poke.ts` 及其内部 transport 测试, 因为 auto-poke, retry, channel, Codex, opencode, tmux 路径已经共享它。

2. 新增小型持久化表 `message_delivery_status`。

   每个 `(message_id, agent_id)` 保存一行, 字段包含 `wake_status`, `skip_reason`, `retry_attempts`, `updated_at`, 可选 `delivered_at`。  这样不用在 `messages` 上混入 per-recipient fan-out 状态, 对 direct send, broadcast, role broadcast 都一致。

3. 新增只读 MCP tool `get_delivery_status`。

   工具接受 `{ message_id: string }`, 要求 caller 必须是该 message 的 sender, 返回每个 recipient 的 wake status。  Recipient 不能用它查看其它 sender 的投递状态。

4. 使用显式 wake-status 值。

   `delivered` 表示 wake hint 已到达 delivery transport。  `retrying` 表示 quiet-guard 阻止了初次尝试且还有 retry。  `skipped` 表示终态跳过, 例如 `no_pane`, `tmux_unavailable`, `self`, `auto_poke:false`。  `failed` 表示 retry 耗尽或 retry 后 transport error。

5. 不给 `task_add` 增加 notify escape hatch。

   `task_add` 文档不再推荐 `poke`。  如果 agent 希望另一个 agent 注意某个 task, 必须使用普通 mailbox message, 然后查询该 message 的 delivery status。

## Risks / Trade-offs

- 现有测试和文档期待 `poke` 出现在 `tools/list` -> 更新为断言不暴露, 同时保留内部 transport 测试。
- recipient 已活跃导致 retry 取消不是 delivery failure -> 记录为 `skipped`, reason 为 `recipient_active`, 让发送方知道无需继续唤醒。
- Delivery status 只是观察 wake hint 投递, 不是证明对方理解了消息 -> 文档里明确限定为 wake-hint delivery。
