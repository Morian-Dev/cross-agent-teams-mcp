# Claude Code MCP config for cross-agent-teams-mcp

Run once to register the MCP server:

```bash
claude mcp add --scope user cross-agent-teams-mcp http://127.0.0.1:9100/mcp --transport streamable-http
```

Or edit `~/.claude/settings.json` manually:

```json
{
  "mcpServers": {
    "cross-agent-teams-mcp": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:9100/mcp"
    }
  }
}
```

With `--token`:

```json
{
  "mcpServers": {
    "cross-agent-teams-mcp": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:9100/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

## Tmux delivery notes

`register_agent` now best-effort attempts runtime binding after the identity row is created, so tmux-based poke delivery can often come up without a second tool call.  Callers SHOULD NOT pass `tmux_pane_id` to `register_agent`.

## Claude self-registration

Claude Code 推荐优先在当前会话里调用 `register_claude_self(...)`.  这条 helper 会把注册写到 Claude host 当前正在使用的 MCP session 上, 并且可以顺手绑定 proxy 宣告的 `channel_session_id`.  这样后续 `get_inbox`, `send_message`, `poke` 都会立刻沿用同一个身份, 不会出现 "刚注册完, 下一次又 unknown_agent" 的错位。

当用户没有显式指定 `team` 时, 推荐传 `project_dir` 为当前工作目录.  daemon 会用该目录 basename 派生默认 team, 两者都不传时仍回落到 `"default"`.

```text
register_claude_self({
  name: "lead",
  role: "worker",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
  channel_session_id: "csid-abc"
})
```

`model` 在这个 helper 里是可选的.  省略时会回退到 Claude Code 专用默认值。

如果你想继续走统一入口, 也可以直接在当前 Claude 会话里调用:

```text
register_agent({
  client: "claude-code",
  model: "opus-4-7",
  name: "lead",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
  role: "worker",
  channel_session_id: "csid-abc"
})
```

## Session boundary

- `cross-agent-teams-channel` proxy 自己也会连接 daemon, 但它注册的是单独的 `__channel_proxy__` session, 不是你的 owner Claude session。
- `curl` 或别的外部 HTTP client 会创建新的 MCP session.  它们可以注册 daemon 里的 row, 但不会把 Claude 当前工具会话自动变成已注册。
- 如果你的目标是让当前 Claude 会话立刻能继续调 `get_inbox` 等工具, 不要用外部 `curl` 去做 Claude 注册.  请直接在 Claude 当前会话里调用 `register_claude_self(...)` 或 `register_agent({ client: "claude-code", ... })`。
- `bind_channel(...)` 现在主要用于已注册 Claude host 在 proxy 换了新 `channel_session_id` 之后做低层重绑。

如果注册响应里仍然带 `hint`, 说明自动 runtime binding 还没有收敛, 当前还没有可用的 `tmux_pane_id` 作为 tmux fallback.  这时调用 `bind_runtime_identity(...)`.  `detect_tmux_pane(...)` 只建议用于调试。
