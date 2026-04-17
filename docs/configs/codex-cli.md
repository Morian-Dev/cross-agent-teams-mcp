# Codex CLI MCP config for ts-agent-teams

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.ts-agent-teams]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
```

With `--token`:

```toml
[mcp_servers.ts-agent-teams]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
[mcp_servers.ts-agent-teams.headers]
Authorization = "Bearer YOUR_TOKEN"
```
