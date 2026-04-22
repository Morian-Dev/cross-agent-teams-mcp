## Why

当前 daemon 只有 `register_agent`, 没有对称的退出路径.  一旦用户注册到错误的 team, 或者在错误的 MCP session 上完成注册, agents 表里就会留下难以清理的脏记录.

现在需要一个最小但安全的自注销能力, 让当前 agent 只能清理自己的注册状态, 同时避免误删别人或破坏仍在进行中的协作状态.

## What Changes

- 新增 `unregister_self` MCP tool, 仅允许当前已注册 session 注销自己的 agent identity
- 注销成功时删除当前 agent row, 并清理该 agent 的 runtime / delivery 绑定和 contract 订阅
- `unregister_self` 在当前 agent 仍持有进行中 task 时拒绝执行, 避免制造无 owner 的进行中任务
- 注销成功后, 当前 session 立即失去业务工具身份, 后续调用按未注册 session 处理

## Capabilities

### New Capabilities
- None

### Modified Capabilities
- `agent-registry`: 增加当前 session 自注销和注册状态释放

## Impact

- 受影响代码主要在 `src/mcp/tools.ts`, `src/mcp/transport.ts`, agent registry service/repo 和任务查询逻辑
- 需要补充新的 `unregister_self` 测试, 并更新注册状态释放相关测试
- 需要明确与 task ownership, contract subscription 清理, session 绑定释放之间的边界
