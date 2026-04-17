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

## Reporting your tmux pane id on register

If you run this agent inside a tmux pane and want the `poke` MCP tool (or any future cross-agent interrupt) to target you, you SHOULD include your pane id on first `register_agent`.

The agent itself can read the pane id via shell:

    tmux display-message -p '#{pane_id}'

This prints something like `%42`.  Pass it to `register_agent`:

    register_agent({ model: "...", role: "...", team: "...", tmux_pane_id: "%42" })

If you omit `tmux_pane_id`, the daemon's response will include a `hint` field reminding you to re-register with the pane id so `poke` can reach you.  Non-tmux environments (IDE plugin, CI runner, desktop app) can ignore the hint and operate without `tmux_pane_id`.
