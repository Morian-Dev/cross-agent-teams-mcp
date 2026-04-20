# Codex CLI MCP config for cross-agent-teams-mcp

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.cross-agent-teams-mcp]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
```

With `--token`:

```toml
[mcp_servers.cross-agent-teams-mcp]
type = "streamable-http"
url = "http://127.0.0.1:9100/mcp"
[mcp_servers.cross-agent-teams-mcp.headers]
Authorization = "Bearer YOUR_TOKEN"
```

## Reporting your tmux pane id on register

If you run this agent inside a tmux pane and want the `poke` MCP tool (or any future cross-agent interrupt) to target you, you SHOULD include your pane id on first `register_agent`.

The agent itself can read the pane id via shell.  Use the `$TMUX_PANE` environment variable, which tmux sets per-pane and is reliable per-process:

    echo "$TMUX_PANE"

This prints something like `%42`.  Do **NOT** use `tmux display-message -p '#{pane_id}'` as the primary source — it returns the tmux *focused* pane, which may be a different agent's pane when multiple clients share the session.  `tmux display-message` is acceptable only as a fallback if `$TMUX_PANE` is empty.

Pass the result to `register_agent`:

    register_agent({ model: "...", role: "...", team: "...", tmux_pane_id: "%42" })

If you omit `tmux_pane_id`, the daemon's response will include a `hint` field reminding you to re-register with the pane id so `poke` can reach you.  Non-tmux environments (IDE plugin, CI runner, desktop app) can ignore the hint and operate without `tmux_pane_id`.
