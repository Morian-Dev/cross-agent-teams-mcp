## REMOVED Requirements

### Requirement: Agents table includes opencode transport columns
**Reason**: The `opencode-server` HTTP transport is being removed. The columns `agents.opencode_base_url` and `agents.opencode_session_id` have no consumers post-change; keeping them would be permanent NULL tombstones.
**Migration**: `stop-server.sh` wipes `data.db` on shutdown. Post-change daemon bootstrap produces a fresh schema without these columns. Agents bound to opencode hosts carry only `tmux_pane_id` (populated via pid → tty → pane from `register_agent({client:'opencode', ui_pid})`).

### Requirement: list_agents returns opencode transport fields
**Reason**: The underlying columns are being removed (see above), so `list_agents` cannot and should not return them.
**Migration**: `list_agents` entries for opencode agents expose `tmux_pane_id` only; the fields `opencode_base_url` and `opencode_session_id` are removed from response shape. Consumers that filtered or displayed those fields MUST be updated to drop them.

### Requirement: opencode_pane_pre_registrations table exists on fresh databases
**Reason**: The launcher-driven pre-reg flow is being removed. There is no consumer for the table post-change.
**Migration**: No runtime action — `stop-server.sh` wipes state and the post-change bootstrap does not create this table. Any downstream code referencing the table is deleted in the same change.

### Requirement: pre_register_opencode_pane tool records pending tmux pane claim
**Reason**: The MCP tool is being deleted because its only caller (`launch-opencode.sh`) is also deleted and its state store (`opencode_pane_pre_registrations`) is being removed.
**Migration**: The replacement flow is `tmux new-window; opencode; register_agent({client:'opencode', ui_pid:<pid>})`. No pre-reg call is required; the daemon binds the pane directly from `ui_pid`.

### Requirement: pre_register_opencode_pane overwrites existing entry for same pane
**Reason**: The `pre_register_opencode_pane` tool itself is removed (see above).
**Migration**: n/a — no replacement behavior needed.

### Requirement: Expired opencode pre-reg rows are ignored and cleaned up
**Reason**: There is no pre-reg table post-change, so expiry semantics do not apply.
**Migration**: n/a — no replacement behavior needed.

### Requirement: register_opencode_self consumes pre-reg and binds opencode metadata
**Reason**: `register_opencode_self` is being deleted as an MCP tool, and pre-reg consumption has no backing state.
**Migration**: Callers invoke `register_agent({client:'opencode', name, model, ui_pid, project_dir, ...})` instead. The daemon's generic pid-based pane binding path populates `tmux_pane_id`; no opencode-specific metadata is written.

### Requirement: register_opencode_self strict schema rejects unknown keys
**Reason**: The tool is deleted (see above).
**Migration**: n/a — `register_agent`'s existing strict schema covers the replacement flow.

### Requirement: register_opencode_self mirrors register_agent team default derivation
**Reason**: The tool is deleted (see above).
**Migration**: `register_agent` already applies the three-level team precedence (`team` > `basename(project_dir)` > `'default'`), which is the same derivation referenced here. Opencode callers benefit from it automatically.

### Requirement: register_agent client=opencode consumes pre-reg when opencode metadata is omitted
**Reason**: Pre-reg consumption is being removed along with the pre-reg table and the opencode transport columns. The opencode branch of `register_agent` reduces to the same path as `client:'custom'` plus the label preservation.
**Migration**: `register_agent({client:'opencode', ui_pid, ...})` binds only `tmux_pane_id` via the generic pid-based path. No `base_url` / `session_id` fields are accepted or persisted.

### Requirement: register_opencode_self description guides opencode agents toward launcher-driven activation
**Reason**: The tool is deleted (see above) and the launcher is deleted.
**Migration**: n/a — no replacement tool description needed.

### Requirement: register_agent description points opencode callers at register_opencode_self
**Reason**: `register_opencode_self` is deleted (see above). `register_agent`'s description MUST no longer point opencode callers at a tool that does not exist.
**Migration**: Callers use `register_agent({client:'opencode', ui_pid, ...})` directly. `register_agent`'s description SHALL NOT mention `register_opencode_self`, `pre_register_opencode_pane`, `bind_opencode_session`, `base_url`, or `session_id` as opencode-specific concerns.
