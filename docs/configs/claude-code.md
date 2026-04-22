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

`register_agent` no longer performs tmux pane detection during registration.  Callers SHOULD NOT pass `tmux_pane_id` to `register_agent`.

If registration succeeds but returns a `hint`, that means no usable `tmux_pane_id` is bound yet for tmux-based poke delivery.  Call `bind_runtime_identity(...)` after registration.  Use `detect_tmux_pane(...)` only for debugging.  Claude Code users with the channel plugin can also rely on `bind_channel(...)`, which does not depend on tmux.
