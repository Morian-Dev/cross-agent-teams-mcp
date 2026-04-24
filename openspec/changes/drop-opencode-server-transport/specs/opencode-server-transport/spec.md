## REMOVED Requirements

### Requirement: bind_opencode_session writes opencode session metadata to caller row
**Reason**: The `opencode-server` HTTP transport is being deleted in favor of the plain tmux paste/Enter path. `bind_opencode_session` has no post-change function because the two columns it writes (`agents.opencode_base_url`, `agents.opencode_session_id`) are also being dropped.
**Migration**: Run opencode inside a tmux pane and register via `register_agent({ client:'opencode', name:'...', model:'...', ui_pid:<opencode pid>, project_dir:'...' })`. The daemon binds the caller's `tmux_pane_id` via pid → tty → pane, and subsequent pokes deliver through tmux. No HTTP-transport binding is available post-change.

### Requirement: Direct poke can deliver through opencode server session
**Reason**: The `opencode-server` transport, including the `transport_used: 'opencode-server'` response variant, is being deleted outright. Poke delivery for `client:'opencode'` agents collapses onto the generic tmux pane path used by `client:'custom'`.
**Migration**: Callers observe `transport_used: 'tmux-poke'` on successful delivery to opencode targets. Response payload carries `pane_id` + `pane_tail_before` / `pane_tail_after` in place of the removed `base_url` + `session_id` fields.

### Requirement: opencode transport surfaces classified delivery errors
**Reason**: The error codes `opencode_session_not_bound`, `opencode_unreachable`, `opencode_session_not_found`, `opencode_session_busy`, `opencode_request_failed` apply only to the HTTP transport being deleted.
**Migration**: Delivery failures surface through the existing tmux error classifier (`pane_dead`, `tmux_cmd_failed`, `tmux_unavailable`, `tmux_pane_not_set`) — identical to how `client:'custom'` failures already surface. No opencode-specific error codes remain in the public API.
