# Claude Code MCP config for ts-agent-teams

Run once to register the MCP server:

```bash
claude mcp add --scope user ts-agent-teams http://127.0.0.1:9100/mcp --transport streamable-http
```

Or edit `~/.claude/settings.json` manually:

```json
{
  "mcpServers": {
    "ts-agent-teams": {
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
    "ts-agent-teams": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:9100/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```
