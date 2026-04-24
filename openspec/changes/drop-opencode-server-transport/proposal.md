## Why

opencode cannot reliably self-identify as opencode inside its own MCP session, which breaks the premise of the launcher pre-register → TUI self-register → auto-bind handshake that the `opencode-server` HTTP transport relies on. Real usage has shown the handshake fails to converge in practice, leaving behind a large surface area (launcher script, pre-reg table, HTTP transport, 3 MCP tools, 2 schema columns, 1 capability) that does not deliver value. Removing the special path and reusing the existing tmux paste/Enter transport — which is already how `custom` clients work and which continues to use the `tmux-pane-detect` command-line regex to locate opencode panes from the outside — gives opencode a single, reliable delivery path with far less code.

## What Changes

- **BREAKING** Remove the `opencode-server` transport: delete `src/mcp/opencode-transport.ts` and the `opencode-server` branch from `transport-dispatch.ts` / `poke.ts`; drop `transport_used: 'opencode-server'` from the `PokeResult` / `DispatchResult` union.
- **BREAKING** Remove the opencode-specific MCP tools: `register_opencode_self`, `bind_opencode_session`, `pre_register_opencode_pane`.
- **BREAKING** Remove the pane pre-registration path for opencode: delete `src/mcp/pre-register-opencode-pane.ts`, `src/mcp/auto-bind-opencode-pane.ts`, `src/mcp/bind-opencode-session.ts`, `src/mcp/register-opencode-self.ts`, and `src/storage/opencode-pane-prereg-repo.ts`.
- **BREAKING** Drop the schema artifacts: columns `agents.opencode_base_url`, `agents.opencode_session_id`, and the entire `opencode_pane_pre_registrations` table. Do not leave tombstones; on-disk history is wiped by `stop-server.sh`.
- **BREAKING** Delete `launch-opencode.sh` and `test-opencode-poke.mjs` entirely. Users start opencode as a plain TUI inside tmux; registration happens via the generic `register_agent({ client: 'opencode', ui_pid, ... })` flow.
- Remove opencode wiring in horizontal code: opencode reads from `send-message.ts`, `broadcast.ts`, `broadcast-to-role.ts`, `agent-public-row.ts`; the opencode arm of `tools.ts`'s `client === 'opencode' && (base_url | session_id)` validation; the opencode paragraph in `src/mcp/transport.ts` MCP instructions.
- Delete the entire `openspec/specs/opencode-server-transport/` capability and all twelve opencode-specific requirements in `agent-registry` (two schema requirements for the transport columns and the pre-reg table; two `list_agents` / `detect_tmux_pane` surface requirements; four `pre_register_opencode_pane` tool requirements; four `register_opencode_self` / `register_agent({client:'opencode'})` pre-reg-consumption requirements).
- Delete opencode-only tests: `tests/opencode-*.test.ts`, `tests/launch-opencode.test.ts`, `tests/pre-register-opencode-pane-*.test.ts`, `tests/register-opencode-self-tool.test.ts`, `tests/register-agent-opencode-pre-reg.test.ts`, `tests/poke-opencode-no-fanout.test.ts`.
- Preserve the opencode label and external detection: `ClientKind` keeps the `'opencode'` member (observability tag only); `src/daemon/tmux-pane-detect.ts` and `src/daemon/runtime-identity.ts` keep their `opencode` command-line regexes so the daemon can still locate opencode panes from the outside. `register_agent`, `detect_tmux_pane`, and the mcp-transport Phase 0 connectivity test keep `'opencode'` as a valid client value.
- Rewrite the opencode sections of `README.md`, `README.zh-CN.md`, and `docs/configs/opencode.md` to describe the "plain tmux TUI + generic `register_agent`" path.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `opencode-server-transport`: REMOVED — the entire capability is deleted. No more HTTP transport, no `bind_opencode_session` tool, no classified `opencode_*` error codes.
- `agent-registry`: MODIFIED (delta uses `## REMOVED Requirements`) — all twelve opencode-specific requirements are removed: `Agents table includes opencode transport columns`, `list_agents returns opencode transport fields`, `opencode_pane_pre_registrations table exists on fresh databases`, `pre_register_opencode_pane tool records pending tmux pane claim`, `pre_register_opencode_pane overwrites existing entry for same pane`, `Expired opencode pre-reg rows are ignored and cleaned up`, `register_opencode_self consumes pre-reg and binds opencode metadata`, `register_opencode_self strict schema rejects unknown keys`, `register_opencode_self mirrors register_agent team default derivation`, `register_agent client=opencode consumes pre-reg when opencode metadata is omitted`, `register_opencode_self description guides opencode agents toward launcher-driven activation`, `register_agent description points opencode callers at register_opencode_self`. Keeps `'opencode'` as a valid `client` enum value on `register_agent`, `detect_tmux_pane`, and the mention inside `register_agent client=claude-code auto-binds channel_session_id via ui_pid match` ("callers with other client kinds (`codex`, `opencode`, `custom`) are NOT affected by auto-bind").

Note: `agent-delivery` and `mcp-transport` specs are NOT modified. `agent-delivery`'s `DeliverySpec.kind` enum already only includes `'none' | 'claude-channel' | 'codex-appserver'` — opencode transport was never in this spec, it lived in its own capability. `mcp-transport`'s Phase 0 three-client test explicitly names opencode as a simulated client (preserved), and the `instructions` field requirements only mandate the `xats` abbreviation and team-default convention, not the opencode-specific paragraph that `src/mcp/transport.ts` currently prepends (which is a code-level concern only).

## Impact

- Code: ~600 lines removed across `src/mcp/`, `src/storage/`, plus the `launch-opencode.sh` and `test-opencode-poke.mjs` scripts.
- Schema: `agents.opencode_base_url`, `agents.opencode_session_id`, and `opencode_pane_pre_registrations` dropped. No migration compatibility — `stop-server.sh` already wipes on-disk history and this project has a single operator.
- MCP tool surface: three tools removed (`register_opencode_self`, `bind_opencode_session`, `pre_register_opencode_pane`). Tool count on the public MCP surface decreases accordingly.
- Tests: the 10+ opencode/launcher-specific test files listed above are deleted. Cross-cutting tests that reference the opencode transport (poke, broadcast, send-message, register_agent) are updated to the tmux-only path.
- Docs: README (EN + 中文) and `docs/configs/opencode.md` rewritten for the tmux-only path. discuss/ history is left intact as historical record.
- Downstream users: anyone relying on `launch-opencode.sh`, the `opencode-server` transport, or the three removed MCP tools must migrate to `tmux new-window; opencode; register_agent({ client: 'opencode', ui_pid: <pid>, ... })`. This is a hard break, called out as BREAKING above.
