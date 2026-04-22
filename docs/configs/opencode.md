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

`register_agent` now best-effort attempts runtime binding after the identity row is created, so tmux-based poke delivery can often come up without a second tool call.  Callers SHOULD NOT pass `tmux_pane_id` to `register_agent`.

If registration still returns a `hint`, that means automatic runtime binding did not converge and there is still no usable `tmux_pane_id` for tmux-based poke delivery.  Call `bind_runtime_identity(...)` to bind explicitly.  Use `detect_tmux_pane(...)` only for debugging.  Non-tmux environments can ignore the hint.
