## Why

Codex 0.124.0 exposes `CODEX_THREAD_ID` (and `CODEX_COMPANION_SESSION_ID`) as environment variables inside the MCP tool shell it spawns.  That means a codex agent *can* self-discover its own thread_id and register for `codex-appserver` delivery entirely on its own — the earlier assumption that this required a codex upstream change was wrong.

Today the path is clumsy:
- There is no codex-specific convenience tool (`register_claude_self` exists; no equivalent for codex).
- The `register_agent` tool description says nothing about `$CODEX_THREAD_ID`.  Codex agents have no reason to read it, so they don't — the one that found it did so by accident.
- Codex agents instinctively hunt for `ui_pid` (via `$PPID` then manual `ps`).  `$PPID` gets rejected (it's the app-server), and the manual `ps` detour defeats the `add-codex-pane-pre-register` auto-bind that we just shipped — when `ui_pid` is provided, the daemon skips the pre-reg path entirely.

The fix is purely surface-level.  The `RegisterCodexSelfService` already knows how to register a codex-appserver delivery; we just need a proper MCP entry point for it, plus documentation that tells codex agents how to use it.

## What Changes

- Add a new MCP tool `register_codex_self({name, thread_id?, ws_url?, auth_token_ref?, role?, team?, project_dir?})`.  It is a thin wrapper around the existing `RegisterCodexSelfService`, scoped to `client=\"codex\"`, with `ws_url` defaulting to `ws://127.0.0.1:8799`.  It does **NOT** accept `ui_pid`, `tmux_pane_id`, `delivery`, `channel_session_id`, or any opencode-specific field — this is deliberate: ui_pid discovery is the job of the `codex_pane_pre_register` auto-bind path, not the agent.
- Tool description tells the LLM: "read `$CODEX_THREAD_ID` from your tool shell environment and pass it as `thread_id`; do **not** attempt to discover `ui_pid`; the daemon auto-binds your tmux pane via the launcher's pre-reg if one is active."
- When the caller omits `thread_id`, the existing `thread_id_required` fallback (lists loaded threads) stays in effect unchanged — same semantics as today's `register_agent({client:"codex", ws_url})`.
- Update the top-level `cross-agent-teams-mcp` MCP server instructions (the block that appears as part of `## cross-agent-teams-mcp` in the system-reminder MCP-server-instructions) to add a Codex section: tell codex clients to read `$CODEX_THREAD_ID` and prefer `register_codex_self`, and to NOT pass `ui_pid` because the launcher handles pane binding through pre-reg.
- Update the `register_agent` tool description to explicitly discourage codex callers from passing `ui_pid` and point them at `register_codex_self`.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `agent-registry`: adds the `register_codex_self` tool as a new codex-specific convenience entry point.  Updates the `register_agent` tool description so codex callers are guided away from manual `ui_pid` passing.  The underlying `RegisterCodexSelfService` behavior is not changing.

## Impact

- `src/mcp/tools.ts`: register a new `register_codex_self` tool; update the `register_agent` tool description text.
- No changes to `RegisterCodexSelfService`, schema, or delivery dispatch — this is purely a new tool surface.
- `README.md` or wherever the server instructions are authored (embedded in `src/mcp/server.ts` / `transport.ts` or similar): append codex-specific guidance to the `cross-agent-teams-mcp` instructions block.
- No new tests of the service layer (already covered).  Add a small test verifying the new tool's happy path and schema surface.
- No schema migration.  No launcher change.  No docs change beyond server instructions.
