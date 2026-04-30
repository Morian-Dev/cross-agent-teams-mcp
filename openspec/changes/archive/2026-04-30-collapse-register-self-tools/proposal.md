## Why

In practice, agent harnesses often do not know what `agent_type` kind they are. A real example: cursor (the editor) registered once via `register_codex_self`, then re-registered via `register_claude_self`, polluting its `agents.agent_type` column with `claude-code` even though it is neither codex nor Claude Code. The two convenience tools (`register_claude_self`, `register_codex_self`) optimize for "agents that already know their identity"; in the failure mode that actually happens, an LLM pattern-matches on tool name and picks the wrong one. Collapsing to a single `register_agent` entry point with explicit `agent_type=` (and a `custom` fallback) eliminates this misclassification.

## What Changes

- **BREAKING**: Remove the `register_claude_self` MCP tool from `tools/list`. Equivalent behavior is reachable via `register_agent({ agent_type: "claude-code", ... })`.
- **BREAKING**: Remove the `register_codex_self` MCP tool from `tools/list`. Equivalent behavior is reachable via `register_agent({ agent_type: "codex", thread_id, ... })`.
- Move `defaultClaudeSelfModel(getSessionClientInfo?.())` model-sniff fallback into the unified `register_agent` path so it auto-applies when `agent_type="claude-code"` and `model` is omitted.
- Default `ws_url=""` when `agent_type="codex"` and the caller omits `ws_url`, preserving the codex-appserver path (and the `thread_id_required` candidate envelope) for `register_agent` callers.
- Add a Zod refinement: `agent_type="codex"` requires `thread_id`; missing `thread_id` is the launcher pre-reg scenario, which uses `pre_register_codex_pane` (not the self-register entry point).
- Extend `register_agent` tool description with a **DETECTION** block listing four known agent types — `codex` (env `CODEX_THREAD_ID`), `claude-code` (env `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT`), `opencode` (binary `opencode` on PATH), `cursor` (env `CURSOR_TRACE_ID` / parent process `Cursor Helper`) — plus the fallback rule: none match → `agent_type="custom"` with required `agent_type_name`.
- Delete the `defaultClaudeSelfModel` helper if it is no longer referenced outside the deleted tool registration block (after inlining the model-default logic into `executeRegister`). `RegisterCodexSelfService` STAYS — it is already invoked from `executeRegister` for the `agent_type="codex" + thread_id|ws_url|auth_token_ref` branch and serves `register_agent` callers, not just the deleted self tool.
- Rewrite `README.md` and `README.zh-CN.md` to remove all recommendations of the two self tools and instead show `register_agent({ agent_type, ... })` with a DETECTION example block.
- Rewrite or delete tests that target the deleted MCP tool surface (`tests/register-claude-self-csid-uipid-mismatch.test.ts`, `tests/register-codex-self-tool.test.ts`, and any others that import the tool names directly). Behavior-coverage tests are repointed at `register_agent({ agent_type: "claude-code"|"codex", ... })`.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `agent-registry`: remove all `register_claude_self` and `register_codex_self` requirements/scenarios; replace with equivalent requirements scoped to `register_agent({ agent_type: "claude-code"|"codex", ... })`; add the DETECTION-table requirement for `register_agent`'s tool description; add the `agent_type="codex"` → `thread_id` required schema refinement requirement.
- `mcp-transport`: remove the `register_claude_self` reference from the team-default-on-registration requirement; restate it in terms of `register_agent` only.

## Impact

- **Tool surface (BREAKING)**: MCP clients that currently call `register_claude_self` / `register_codex_self` will get `tool not found`. Migration: switch to `register_agent({ agent_type: "claude-code"|"codex", ... })`. Version bumps to `0.4.0` (minor under 0.x signals a breaking change in this codebase's npm publish line).
- **Source files**: `src/mcp/tools.ts` (delete two `server.registerTool` blocks; move model-default + ws_url-default + DETECTION text + zod refinement into `register_agent`; inline or delete `defaultClaudeSelfModel`). `src/mcp/register-codex-self.ts` and `RegisterCodexSelfService` STAY — `executeRegister` keeps routing `register_agent({agent_type:'codex'})` calls through it. `src/mcp/transport.ts` only needs reference cleanup (no behavioral change).
- **Tests**: ~5–10 test files explicitly reference the self-tool names. Each is either deleted (if it only verified the wrapper existed) or repointed at `register_agent`.
- **Docs**: `README.md`, `README.zh-CN.md`, plus any internal docs under `docs/`.
- **No DB migration**: `agents.agent_type` column already exists with values `codex|claude-code|opencode|custom`; no schema change needed.
- **No daemon protocol change**: registration backends (`registerSvc.register`, `registerCodexSelfSvc.register`) keep their internal API; only the MCP-tool surface changes.
