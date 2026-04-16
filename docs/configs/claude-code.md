# Claude Code MCP config for agent-teams-mcp

Run once to register the MCP server:

```bash
claude mcp add --scope user agent-teams http://127.0.0.1:9099/mcp --transport streamable-http
```

Or edit `~/.claude/settings.json` manually:

```json
{
  "mcpServers": {
    "agent-teams": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:9099/mcp"
    }
  }
}
```

With `--token`:

```json
{
  "mcpServers": {
    "agent-teams": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:9099/mcp",
      "headers": { "Authorization": "Bearer YOUR_TOKEN" }
    }
  }
}
```
