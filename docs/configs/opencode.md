# opencode MCP config for cross-agent-teams-mcp

Add to `~/.config/opencode/config.json`:

```json
{
  "mcp": {
    "cross-agent-teams-mcp": {
      "type": "streamable_http",
      "url": "http://127.0.0.1:9100/mcp"
    }
  }
}
```

If you started the daemon with `--token`, add the bearer header:

```json
{
  "mcp": {
    "cross-agent-teams-mcp": {
      "type": "streamable_http",
      "url": "http://127.0.0.1:9100/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```

## Tmux delivery notes

`register_agent` no longer performs tmux pane detection during registration.  Callers SHOULD NOT pass `tmux_pane_id` to `register_agent`.

If registration succeeds but returns a `hint`, that means no usable `tmux_pane_id` is bound yet for tmux-based poke delivery.  Call `bind_runtime_identity(...)` after registration.  Use `detect_tmux_pane(...)` only for debugging.  Non-tmux environments can ignore the hint.
