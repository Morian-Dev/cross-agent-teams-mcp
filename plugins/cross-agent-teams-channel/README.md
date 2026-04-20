# cross-agent-teams-channel

Claude Code channel proxy for the cross-agent-teams-mcp daemon.

## 用途

这个 plugin 是一个独立的 stdio MCP server, 作为 Claude Code 与 cross-agent-teams-mcp daemon 之间的 channel 桥接.  它声明 `capabilities.experimental['claude/channel']: {}` 以启用 Claude Code Channels 协议, 把从 daemon 收到的 `notifications/channel_wake` 中继为 `notifications/claude/channel` 发给 host Claude Code.

## 启动

```
cross-agent-teams-channel-proxy --daemon-url http://localhost:8787 --agent-team default --agent-name alice
```

或通过环境变量 `TS_AGENT_TEAMS_DAEMON_URL` 提供 daemon URL.

## 持久化

proxy 将生成的 `channel_session_id` 持久化到 `<cache_dir>/cross-agent-teams-channel/<team>-<name>.json`, 其中 `<cache_dir>` 是 `$XDG_CACHE_HOME` 或 `~/.cache` (POSIX) / `%LOCALAPPDATA%` (Windows).

## 安全

此 plugin 使用 Claude Code 的 Channels research preview 协议, 本地开发时需配合 `--dangerously-load-development-channels` 使用.
