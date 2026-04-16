# Codex CLI MCP config for agent-teams-mcp

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.agent-teams]
type = "streamable-http"
url = "http://127.0.0.1:9099/mcp"
```

With `--token`:

```toml
[mcp_servers.agent-teams]
type = "streamable-http"
url = "http://127.0.0.1:9099/mcp"
[mcp_servers.agent-teams.headers]
Authorization = "Bearer YOUR_TOKEN"
```
