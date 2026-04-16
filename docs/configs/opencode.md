# opencode MCP config for agent-teams-mcp

Add to `~/.config/opencode/config.json`:

```json
{
  "mcp": {
    "agent-teams": {
      "type": "streamable_http",
      "url": "http://127.0.0.1:9099/mcp"
    }
  }
}
```

If you started the daemon with `--token`, add the bearer header:

```json
{
  "mcp": {
    "agent-teams": {
      "type": "streamable_http",
      "url": "http://127.0.0.1:9099/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```
