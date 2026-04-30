## Why

The `client` field on `register_agent` (and the corresponding `agents.client` DB column) is semantically overloaded with the MCP protocol's "client" — every MCP session has a `clientInfo` block and is itself "the MCP client". An LLM reading the tool description has to mentally distinguish "the MCP client" (the calling session) from "the client field" (the runtime category of the registering agent). In field testing during `collapse-register-self-tools`, a real misclassification happened (cursor mis-detected as opencode); part of that confusion came from probing logic, but the field name itself contributes by inviting "what client am I talking to?" reasoning instead of "what type of agent am I?".

Renaming `client` → `agent_type` aligns the field with the project's primary noun (`agent_id`, `agents` table, `register_agent`, `list_agents`) and matches the community vocabulary where claude-code / codex / cursor / opencode are colloquially called "code agents". The companion field `client_name` is renamed in lockstep to `agent_type_name` for symmetry.

## What Changes

- **BREAKING (MCP tool surface)**: Rename the `register_agent` input field `client` → `agent_type` and `client_name` → `agent_type_name`. The Zod schema, `executeRegister` arg shape, and all internal helper signatures are updated.
- **BREAKING (storage)**: Rename the `agents.client` column → `agents.agent_type`, and `agents.client_name` → `agents.agent_type_name`. Add an idempotent startup migration via `ALTER TABLE agents RENAME COLUMN` for existing databases.
- **BREAKING (TypeScript public types)**: Rename the exported type `ClientKind` → `AgentType`. The string enum values (`'codex' | 'claude-code' | 'opencode' | 'custom'`) are unchanged.
- **BREAKING (other tools)**: Cascade the rename to other registered tools that reference the same enum or field — `detect_tmux_pane({agent})` and `bind_runtime_identity({agent})` currently take an `agent: ClientKind` arg; rename internally to keep the same field name (`agent`) but switch the type alias name (no schema break for those tools).
- **BREAKING (response shape)**: `list_agents` returns rows with `client` / `client_name` keys — rename to `agent_type` / `agent_type_name`. Other response keys (`agent_id`, `name`, `team`, `role`, `model`, `delivery`, `channel_session_id`, `tmux_pane_id`, `last_seen_at`, `online`) are unchanged.
- The `register_agent` tool description, the MCP `serverInfo.instructions` string, README files, and `docs/configs/*` are updated everywhere `client` / `client_name` appears as a field reference (NOT where they refer to MCP clients in general — those usages stay).
- All affected tests (~50 files reference the field) are updated mechanically: `client: 'X'` → `agent_type: 'X'`, `client_name: 'Y'` → `agent_type_name: 'Y'`, plus DB column assertions in `tests/agents-schema.test.ts` and similar.
- Bump `package.json` version to `0.5.0` (under 0.x, a minor bump signals breaking; this comes after `0.4.0` for the `collapse-register-self-tools` change).

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `agent-registry`: rename the `client` and `client_name` field across every requirement and scenario that names them — the agents table schema requirement, the `register_agent` field requirements, the `list_agents` response requirements, the `register_agent` description DETECTION block, and any other text mentioning the field. Add a new requirement for the column-rename startup migration.
- `mcp-transport`: rewrite the `serverInfo.instructions` requirement to use `agent_type` instead of `client`.
- `claude-channel-transport`: any references to the `client` field are renamed.

## Impact

- **Tool surface (BREAKING)**: MCP callers passing `client: '...'` to `register_agent` will get a Zod validation error (unknown key `client`, missing required `agent_type`). Migration: rename the field name in the call site.
- **Storage (BREAKING)**: existing databases get an in-place column rename via `ALTER TABLE agents RENAME COLUMN`. The data migrates without loss; no backfill needed.
- **Source files**: ~12 files under `src/` reference `client` as a field/type name (`tools.ts`, `transport.ts`, `transport-dispatch.ts`, `register-agent.ts`, `register-codex-self.ts`, `agents-repo.ts`, `schema.ts`, `agent-public-row.ts`, `poke.ts`, `lib/client-kind.ts`, plus the storage migration site).
- **Tests**: every test file that touches register_agent or inspects the agents table needs the field rename. Mechanical replace.
- **Docs**: `README.md`, `README.zh-CN.md`, `docs/configs/claude-code.md`, `docs/configs/codex-cli.md`, `CHANGELOG.md`, plus the proposal/design/specs of the in-flight `collapse-register-self-tools` change.
- **Sequencing with `collapse-register-self-tools`**: that change is currently active (apply done, not archived). It writes spec deltas using the old `client` name. To minimize merge friction, this change SHOULD be applied AFTER `collapse-register-self-tools` is archived (so the rename's MODIFIED-Requirements pick up the post-collapse text). Design.md captures this ordering decision.
- **No daemon protocol-level break beyond the field name**: Streamable HTTP transport, MCP framing, channel-proxy protocol are unchanged.
- **`channel_session_id`, `claude_ui_pid`, `runtime_ui_pid`** field/column names retain "claude" because they specifically reference the Claude Code channel proxy mechanism — those are out of scope here.
