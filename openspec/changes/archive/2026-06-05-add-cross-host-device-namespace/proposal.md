## Why

The daemon currently binds only to `127.0.0.1`, so all collaborating agents must live on the same machine.  When two teammates on a LAN want their Claude Code instances to talk, there is no supported path.  The existing channel-cli is already a complete three-stage proxy (daemon ↔ proxy ↔ local PID), so letting it connect from a peer host preserves poke delivery without introducing daemon federation — but doing so exposes a name-collision problem: both machines may have an agent named `creator`, and the current `(team, name)` identity key cannot tell them apart.

We solve both at once: open the daemon to LAN under bearer auth, and lift the agent identity to `(device, team, name)` so per-device agents coexist and are addressable via a `name:device` suffix.

## What Changes

- **BREAKING (storage)**: `agents` identity key changes from `(team, name)` to `(device, team, name)`; the UNIQUE index `agents_identity_idx` is rebuilt over the new tuple.  An additive migration adds the `device TEXT NOT NULL` and `remote_addr TEXT NULL` columns and backfills existing rows with the daemon's local device label (default `os.hostname()`).
- **BREAKING (tool input)**: `register_agent.name` and the new `register_agent.device` field MUST NOT contain `:`.  Existing valid names are unaffected (none currently contain `:`).
- `daemon-core` gains `--host <addr>` (default `127.0.0.1`) and `--device <label>` (default `os.hostname()`-derived).  When `--host` resolves to a non-loopback address, the daemon refuses to start without `--token` (`token_required_for_non_loopback_bind`).
- `mcp-transport` tags each MCP session at request entry as `origin: 'local' | 'remote'` (loopback ⇒ local, otherwise remote) and stashes the peer address.  This is **internal-only** — no user-visible tool exposes `origin` or `remote_addr`.
- `register_agent` accepts an optional `device` argument.  From a loopback session the daemon enforces it equals the local label (or auto-fills it); from a remote session `device` is required and MUST NOT equal the local label.
- `mailbox` resolves `to_agent_name = "name:device"` against the explicit device; bare `to_agent_name` resolves against the caller's device.  `broadcast` and `broadcast_to_role` expand to "caller's team across all devices".  `send_message_by_id` is unchanged.
- `list_agents` adds a `device` field and widens scope to "caller's team across all devices" so callers can see who to address with `:device`.  Other identifying fields stay the same; `origin` / `remote_addr` are NOT returned.
- `claude-channel-transport` auto-bind matches `(device, claude_ui_pid)` instead of `claude_ui_pid` alone to disambiguate cross-host PID collisions.
- `channel-cli-bin` (the `cross-agent-teams-channel` published bin) accepts `--token` / `CROSS_AGENT_TEAMS_MCP_TOKEN` and `--device <label>` (default `os.hostname()`).  The proxy forwards `device` into its `register_agent` upsert.
- Docs: README / README.zh-CN gain a "Cross-host (LAN) collaboration" section with the launch commands and security notes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-registry`: identity key, schema (new `device`, `remote_addr` columns), `register_agent` input shape, name/device validation, migration semantics.
- `daemon-core`: bind-address flag, device flag, non-loopback token requirement.
- `mcp-transport`: per-session origin tagging (internal-only).
- `mailbox`: `to_agent_name` name:device parsing, broadcast scope across devices, unknown_recipient resolution against the new identity tuple.
- `claude-channel-transport`: auto-bind keyed on `(device, claude_ui_pid)`.
- `channel-cli-bin`: `--token` and `--device` flags.

## Impact

- **Storage**: schema migration on first startup of the new daemon version (adds two columns, rebuilds identity index).  Idempotent.
- **Wire**: `register_agent` gains an optional `device` field; `list_agents` adds a `device` field; `send_message`/`broadcast` accept `name:device` syntax.  Old clients on loopback continue to work because `device` is auto-filled.
- **CLI**: new flags on both `cross-agent-teams-mcp daemon` and `cross-agent-teams-channel`.  Defaults preserve current single-host behavior.
- **Security**: opening the daemon beyond loopback now requires `--token`; the safety net is enforced at startup.
- **Docs**: README pair adds cross-host section; no other behavioral docs need rewriting.
- **Out of scope**: daemon-to-daemon federation, per-agent auth, device whitelisting, exposing `origin` to user-visible tools.
