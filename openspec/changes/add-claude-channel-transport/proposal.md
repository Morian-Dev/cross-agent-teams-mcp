## Why

现有 `poke` 工具通过 `tmux load-buffer + paste-buffer + send-keys Enter` 把 prompt 粘贴到目标 Claude Code 所在 tmux pane.  这种方式有两个结构性问题:

1.  **对方 mid-turn**: Enter 被 Claude Code 的终端 readline 吞掉或错位, 要么干扰当前生成, 要么被无声丢弃
2.  **用户在目标 pane 输入**: 粘贴文本和用户键入混在一起, 破坏用户输入

Claude Code v2.1.80+ 提供了 Channels (research preview): 外部 MCP server 声明 `capabilities.experimental['claude/channel']: {}`, 通过 `notifications/claude/channel` 把事件以 `<channel>` 标签注入 Claude 上下文, 让 Claude 在下一个自然决策点 react.  这是目前官方唯一"不靠 tmux 键盘注入"的外部唤醒路径.

本变更引入 channel-based poke transport, 并建立 transport 抽象层, 为未来 codex / opencode 等其他 agent 的类似机制预留扩展位置.

## What Changes

### 新增能力

-  新 capability `claude-channel-transport`:
    -  一个独立 stdio MCP 子进程 (plugin, 放在 `plugins/ts-agent-teams-channel/`)
    -  由 Claude Code 通过 `.mcp.json` 或 `--channels` 启动, 声明 `claude/channel` experimental capability
    -  作为 HTTP MCP client 连中央 daemon
    -  订阅 daemon 推送的 `notifications/channel_wake`, 转译为 `notifications/claude/channel` 发给其 host Claude Code
-  daemon 侧新增:
    -  `ChannelWakeFanout`: 按 `channel_session_id` 索引的内存 sink 映射, 与现有 `SseFanout` (按 `agent_id` 索引) 分离
    -  `sendChannelWake(channel_session_id, {content, meta})` 内部函数
    -  MCP tool `subscribe_channel_wake({channel_session_id})`: 只允许 `role='__channel_proxy__'` 的调用者使用, 将调用会话的 notification sink 绑到 fanout
    -  MCP tool `bind_channel({team, name, channel_session_id})`: 把业主 agent 的 `channel_session_id` 列写入 agents 表 (协议侧绑定, proxy 调)

### 修改能力

-  `agent-registry`:
    -  `agents` 表新增可选列 `channel_session_id TEXT`
    -  `register_agent` response hint 规则: 既无 `tmux_pane_id` 又无可用 `channel_session_id` 才提示
    -  `list_agents` 返回 `channel_session_id` 字段
-  `mailbox`:
    -  `poke({target_agent_id, prompt})` 改为 transport dispatch: 优先 channel, 无 sink / 发送失败时降级 tmux, 两者都不可用时返回 `no_transport_available`
    -  响应新增 `transport_used: 'claude-channel' | 'tmux-poke'` 字段

### Non-goals

-  双向 reply: Claude 通过 channel 回消息调用独立 `reply_via_channel` tool — 留到后续变更; 本次所有回复仍走 `send_message`
-  codex / opencode 的 channel transport — 留到后续; 本次建立 transport 抽象层, 为它们预留位置
-  将 channel plugin 提交到 Anthropic 官方 allowlist — 开发期用 `--dangerously-load-development-channels`

## Impact

-  **代码新增**:
    -  `plugins/ts-agent-teams-channel/plugin.json`, `src/proxy.ts`
    -  `src/mcp/transport-dispatch.ts` (transport 抽象 + 分发器)
    -  `src/daemon/channel-wake-fanout.ts`
    -  `src/daemon/channel-wake-send.ts`
    -  `src/mcp/subscribe-channel-wake.ts`, `src/mcp/bind-channel.ts`
-  **代码修改**:
    -  `src/storage/schema.ts`: `agents` 表加 `channel_session_id TEXT` 列
    -  `src/storage/agents-repo.ts`: `RegisterInput` 加可选 `channel_session_id`, `AgentListRow` 加 `channel_session_id`, repo 持久化和读取
    -  `src/mcp/register-agent.ts`: 接受并透传新字段
    -  `src/mcp/tools.ts`: `register_agent` schema 加 `channel_session_id`, hint 规则扩展, 注册新 tool
    -  `src/mcp/poke.ts`: 改为 dispatcher, 按 transport kind 路由
    -  `src/daemon/server.ts`: wire ChannelWakeFanout; session close 时调 fanout 的 detach-by-session
-  **测试**:
    -  单元: channel_session_id 持久化、 register_agent hint 新分支、 bind_channel、 subscribe_channel_wake 的 role gating 和 session close cleanup、 ChannelWakeFanout 的 attach/detach/send/key-validation、 dispatcher 路由、 proxy 声明 capability + relay 逻辑
    -  集成: daemon 模拟 poke → SSE → 假 channel proxy 收到 wake → 断言其 emit 的 notification payload
    -  运行时 (manual-verify): 真启动一个 Claude Code 实例加载 dev channel plugin, 另一个 agent 调 `poke`, 人工观察 Claude Code 在 mid-turn 和 idle 两种状态的 react.  pane capture + notification wire log 作为证据入档
-  **spec delta**: `claude-channel-transport` (新), `agent-registry` (ADDED column + hint 规则扩展), `mailbox` (MODIFIED poke 语义)
-  **数据库**: MVP 阶段 fresh-boot, 无 legacy migration.  下次启动时 `agents` 表直接带新列
-  **依赖**: 无新外部包; 新增对 `@modelcontextprotocol/sdk` 的 notification API 使用 (已在 dependencies 中)
-  **运行时风险**:
    -  Channels 仍是 research preview, 协议可能变
    -  只支持 claude.ai 登录, 不支持 API key
    -  Mid-turn notification 行为官方未文档化, 必须 runtime-verify
    -  HTTP MCP daemon ↔ stdio MCP proxy ↔ Claude Code 三段链路, 断线重连、 多实例并发、 session 清理需要测试覆盖
