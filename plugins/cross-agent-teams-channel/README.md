# cross-agent-teams-channel

Claude Code channel proxy for the cross-agent-teams-mcp daemon.

## 用途

这个 plugin 是一个独立的 stdio MCP server, 作为 Claude Code 与 cross-agent-teams-mcp daemon 之间的 channel 桥接.  它声明 `capabilities.experimental['claude/channel']: {}` 以启用 Claude Code Channels 协议, 把从 daemon 收到的 `notifications/channel_wake` 中继为 `notifications/claude/channel` 发给 host Claude Code.

## 启动

```
cross-agent-teams-proxy --daemon-url http://localhost:8787 --agent-team default --agent-name alice
```

或通过环境变量 `CROSS_AGENT_TEAMS_MCP_DAEMON_URL` 提供 daemon URL.

## Session model

- proxy 每次启动都会生成新的 `channel_session_id`, 不做持久化。
- proxy 连 daemon 时注册的是自己的 `__channel_proxy__` session, 只负责 `subscribe_channel_wake(...)` 和中继 `notifications/claude/channel`。
- owner Claude host 需要在自己的当前 MCP session 里完成自注册。  推荐直接调用 `register_claude_self(...)`, 或调用 `register_agent({ client: "claude-code", ... })`。
- 不要用外部 `curl` 给 Claude host 代注册。  那样会新建另一个 daemon-side MCP session, 不能替代当前 Claude 会话的身份绑定。

## 安全

此 plugin 使用 Claude Code 的 Channels research preview 协议, 本地开发时需配合 `--dangerously-load-development-channels` 使用.
