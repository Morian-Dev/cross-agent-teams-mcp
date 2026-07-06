# opencode MCP config for cross-agent-teams-mcp

Add to `~/.config/opencode/opencode.json`:

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

## Running opencode inside tmux

opencode integrates with xats as a plain tmux-hosted TUI.  There is no dedicated launcher and no HTTP-based opencode transport — `poke()` is delivered by pasting text into the opencode pane via tmux, the same path `client: "custom"` uses.

Start opencode in a tmux window, then register from inside the opencode MCP session:

```bash
tmux new-window opencode
```

```text
register_agent({
  client: "opencode",
  model: "opencode-default",
  name: "my-opencode-agent",
  project_dir: "/Users/me/workspace/cross-agent-teams-mcp",
  role: "worker",
  ui_pid: <opencode pid>
})
```

Pass the opencode process pid as `ui_pid`.  The daemon performs `pid → tty → tmux pane` verification in the same registration call and writes `tmux_pane_id`.  After that, cross-agent `poke()` delivers with `transport_used: "tmux-poke"`.

When no explicit `team` is specified, pass `project_dir` as your current working directory.  The daemon derives the default team from that directory's basename, and falls back to `"default"` when both are omitted.

If the registration response still contains `hint`, automatic runtime binding did not converge and there is still no usable `tmux_pane_id`.  In that case, call `bind_runtime_identity(...)` with `ui_pid` (or `ui_tty` + `tmux_pane_id`) to bind explicitly.  `detect_tmux_pane(...)` remains useful for debugging ambiguous matches.

## Operator cutover from the HTTP transport

If you are upgrading from a version that shipped the `opencode-server` HTTP transport:

1. Stop the daemon: `./stop-server.sh` — this wipes `data.db` on purpose.  The dropped `opencode_base_url` / `opencode_session_id` columns and the `opencode_pane_pre_registrations` table are not migrated.
2. Rebuild the project: `pnpm build`.
3. Restart: `./start-server.sh`.
4. Remove any shell alias pointing at `launch-opencode.sh` — the script no longer exists, and its CLI helper `pre-register-opencode-pane` has been removed.
5. Re-register your opencode agents via the `register_agent({ client: "opencode", ui_pid, ... })` flow shown above.  The removed MCP tools `register_opencode_self`, `pre_register_opencode_pane`, and `bind_opencode_session` will return `tool_not_found`.
