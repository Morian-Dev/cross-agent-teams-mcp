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

If registration still returns a `hint`, that means automatic runtime binding did not converge and there is still no usable `tmux_pane_id` for tmux-based poke delivery.  Call `bind_runtime_identity(...)` to bind explicitly.  Use `detect_tmux_pane(...)` only for debugging.  Claude Code users with the channel plugin can also rely on `bind_channel(...)`, which does not depend on tmux.
