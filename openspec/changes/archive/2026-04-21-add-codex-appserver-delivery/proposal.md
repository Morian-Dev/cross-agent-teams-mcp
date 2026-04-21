## Why

当前仓库已经为 `codex-appserver` 预留了 `DeliverySpec` 类型和持久化形状, 也用 POC 证明了 `codex app-server` websocket 可以向一个运行中的 Codex TUI thread 注入消息, 但正式产品链路还停在 `kind_not_yet_supported` 和 `dispatcher_not_implemented`.  这导致 Codex 仍然只能依赖 tmux poke, 无法像 Claude channel 一样成为一等 delivery target.

## What Changes

- 新增一个正式的 Codex app-server transport, 允许 daemon 对 `delivery.kind='codex-appserver'` 的 agent 通过 websocket 执行 `initialize -> initialized -> thread/resume -> turn/start` 的 wake-up 注入.
- 打开 `register_agent.delivery` 对 `codex-appserver` 的写入支持, 校验并持久化 `{ thread_id, ws_url, auth_token_ref? }`.
- 修改 poke 分派路径, 将 `codex-appserver` 从当前的 stub `{ error: 'dispatcher_not_implemented' }` 改为真实分派.
- 为 Codex transport 增加失败语义和返回结构, 让调用方能区分 websocket 连接失败, 远端 JSON-RPC 错误, thread 恢复失败, turn/start 失败等情况.
- 调整 `register_agent` 的提示行为: 当 caller 已显式提供非 tmux delivery, 不再强制返回 “缺少 tmux_pane_id” 的 hint.
- 补充对应的单测, 集成测试, 以及 Codex 配置文档, 使 Codex app-server delivery 成为可用路径而不是 POC.

## Capabilities

### New Capabilities
- `codex-appserver-transport`: 规定 daemon 如何连接 Codex app-server websocket, 如何 resume 指定 thread 并注入 poke 文本, 以及对应的成功/失败语义.

### Modified Capabilities
- `agent-delivery`: `codex-appserver` 从“类型预留但写入拒绝, 分派未实现”升级为可写入, 可分派的正式 delivery kind.
- `agent-registry`: `register_agent` 接受并持久化 `codex-appserver` delivery, 缺省 tmux hint 逻辑改为 delivery-aware.
- `agent-interrupts`: `poke` 的结果从 tmux-only 语义扩展为 transport-aware 语义, 支持 `codex-appserver` 成功与失败返回.

## Impact

- 存储与注册: `src/lib/delivery-spec.ts`, `src/mcp/register-agent.ts`, `src/mcp/tools.ts`, `src/storage/agents-repo.ts`
- 分派与 transport: `src/mcp/transport-dispatch.ts`, `src/mcp/poke.ts`, 新增 Codex app-server dispatcher 模块
- 测试: `tests/delivery-spec.test.ts`, `tests/register-agent-delivery.test.ts`, `tests/transport-dispatch.test.ts`, `tests/poke-*`, 以及新增 Codex transport 相关测试
- 文档: `docs/configs/codex-cli.md`, `README.md`, 以及必要的运维/使用说明
