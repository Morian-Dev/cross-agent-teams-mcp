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

## Reporting your tmux pane id on register (optional)

If you run this agent inside a tmux pane and want future `poke`-style cross-agent interrupts to target you,  include your pane id on first `register_agent`.

Get the pane id (inside the agent's own pane, via a shell call):

    tmux display-message -p '#{pane_id}'

This prints something like `%42`.  Pass it to `register_agent`:

    register_agent({ model: "...", role: "...", team: "...", tmux_pane_id: "%42" })

The field is optional.  Non-tmux environments can omit it.
