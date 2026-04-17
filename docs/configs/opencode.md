# opencode MCP config for ts-agent-teams

Add to `~/.config/opencode/config.json`:

```json
{
  "mcp": {
    "ts-agent-teams": {
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
    "ts-agent-teams": {
      "type": "streamable_http",
      "url": "http://127.0.0.1:9100/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```
