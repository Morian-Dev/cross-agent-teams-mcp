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

If your opencode host already knows its local server coordinates, you can bind opencode delivery directly through the unified entry point:

```text
register_agent({
  client: "opencode",
  model: "anthropic/claude-3-5-sonnet-20241022",
  name: "worker-opencode",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
  role: "worker",
  base_url: "http://127.0.0.1:4096",
  session_id: "ses_xxxxx"
})
```

当用户没有显式指定 `team` 时, 推荐传 `project_dir` 为当前工作目录.  daemon 会用该目录 basename 派生默认 team, 两者都不传时仍回落到 `"default"`.

If registration still returns a `hint`, that means automatic runtime binding did not converge and there is still no usable `tmux_pane_id` for tmux-based poke delivery.  Call `bind_runtime_identity(...)` to bind explicitly.  Use `detect_tmux_pane(...)` only for debugging.  `bind_opencode_session(...)` remains available as a low-level rebind tool when an already-registered opencode host needs to swap to a new local session.
