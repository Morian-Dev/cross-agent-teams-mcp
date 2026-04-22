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

If your Claude host already knows the `channel_session_id` announced by the channel proxy, you can bind channel delivery directly through the unified entry point:

```text
register_agent({
  client: "claude-code",
  model: "opus-4-7",
  name: "lead",
  team: "default",
  role: "worker",
  channel_session_id: "csid-abc"
})
```

If registration still returns a `hint`, that means automatic runtime binding did not converge and there is still no usable `tmux_pane_id` for tmux-based poke delivery.  Call `bind_runtime_identity(...)` to bind explicitly.  Use `detect_tmux_pane(...)` only for debugging.  `bind_channel(...)` remains available as a low-level rebind tool when an already-registered Claude host needs to swap to a new `channel_session_id`.
