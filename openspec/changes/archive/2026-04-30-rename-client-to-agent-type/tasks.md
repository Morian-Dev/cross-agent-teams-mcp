## 1. Pre-flight: ensure collapse-register-self-tools is archived first

- [x] 1.1 Verify `openspec/changes/collapse-register-self-tools/` is fully archived into `openspec/specs/` (per design D1). If still active, archive it first via `/openspec-archive-change collapse-register-self-tools`.
- [x] 1.2 If for any reason collapse cannot archive first, switch to the alternative path: rewrite collapse's spec deltas in place to use `agent_type` (per design D4) so the two changes become orthogonal and can archive in either order.

## 2. Storage: column rename + migration (src/storage/)

- [x] 2.1 In `src/storage/schema.ts`, change the `CREATE TABLE agents` statement: `client TEXT` → `agent_type TEXT`, `client_name TEXT` → `agent_type_name TEXT`. Verify column order matches the spec scenario.
- [x] 2.2 Add a startup migration alongside the existing `claude_ui_pid` migration: when `PRAGMA table_info(agents)` reports a `client` column AND no `agent_type` column, run `ALTER TABLE agents RENAME COLUMN client TO agent_type` and `ALTER TABLE agents RENAME COLUMN client_name TO agent_type_name` in a single transaction. Skip both ALTERs if `agent_type` already exists.
- [x] 2.3 In `src/storage/agents-repo.ts`, rename the `RegisterInput` field `client?: ClientKind` → `agent_type?: AgentType`, `client_name?: string` → `agent_type_name?: string`. Update the `AgentRow` interface symmetrically (`client` → `agent_type`, `client_name` → `agent_type_name`).
- [x] 2.4 In `src/storage/agents-repo.ts`, update the INSERT and UPDATE statements: column names in the SQL strings, and the bound-value order — `input.client ?? null` → `input.agent_type ?? null`, `input.client_name ?? null` → `input.agent_type_name ?? null`.
- [x] 2.5 In `src/storage/agents-repo.ts`, update `SELECT` statements that name the columns explicitly (search for `client`, `client_name`).

## 3. Type rename (src/lib/)

- [x] 3.1 Rename `src/lib/client-kind.ts` → `src/lib/agent-type.ts`. Inside the file, rename the exported type `ClientKind` → `AgentType`. Keep the string union `'codex' | 'claude-code' | 'opencode' | 'custom'` unchanged.
- [x] 3.2 Update every `import { ClientKind } from '../lib/client-kind.js'` to `import { AgentType } from '../lib/agent-type.js'` across `src/`.
- [x] 3.3 Replace every `: ClientKind` type annotation with `: AgentType` in `src/`.

## 4. MCP tools (src/mcp/tools.ts)

- [x] 4.1 Rename the Zod schema constant `clientSchema` → `agentTypeSchema` (the `z.enum([...])` value is unchanged).
- [x] 4.2 In `registerAgentInputSchema`, rename the field `client` → `agent_type` and `client_name` → `agent_type_name`. Keep the schema strict and the existing validations (`agent_type_name` only allowed when `agent_type='custom'`).
- [x] 4.3 In the `superRefine` block on `registerAgentArgsSchema`, rename every `data.client` reference to `data.agent_type` (the codex+thread_id rejection rule, and any other refines).
- [x] 4.4 In `executeRegister`, rename every `args.client` to `args.agent_type` and every `args.client_name` to `args.agent_type_name`. Update the function's parameter type accordingly.
- [x] 4.5 Update the call sites that invoke `registerSvc.register({ ... client: args.client, client_name: args.client_name, ... })` — both keys rename.
- [x] 4.6 Rewrite the `register_agent` tool description's DETECTION block and surrounding text: replace every `client="X"` literal with `agent_type="X"` and every `client_name` mention with `agent_type_name`. Preserve the anti-pattern warning, the OPTIONAL note for model, and the CODEX_THREAD_ID / CLAUDECODE / CURSOR_TRACE_ID examples.
- [x] 4.7 Audit other tools (`detect_tmux_pane`, `bind_runtime_identity`) for `: ClientKind` references — rename only the type alias to `AgentType`. The wire-format `agent` field on those tools STAYS named `agent` per design D3.
- [x] 4.8 Search `src/mcp/tools.ts` for any remaining `client` references in tool descriptions (other than legitimate "MCP client" mentions) and rename.

## 5. Other src/ files

- [x] 5.1 In `src/mcp/transport.ts`, rewrite the `serverInfo.instructions` string: replace `client="codex"` → `agent_type="codex"`, `client="claude-code"` → `agent_type="claude-code"`, `client="custom"` → `agent_type="custom"`, `client_name` → `agent_type_name`. Keep all other text (xats abbreviation, project_dir guidance, anti-pattern warning, model OPTIONAL note).
- [x] 5.2 In `src/mcp/register-agent.ts` (the service), rename the `RegisterInput` field `client?: ClientKind` → `agent_type?: AgentType` and `client_name?: string` → `agent_type_name?: string`. Update the call to `this.repo.register({ client: input.client, client_name: input.client_name, ... })` symmetrically.
- [x] 5.3 In `src/mcp/register-codex-self.ts`, audit for any `client` field references in arguments passed to `registerSvc.register(...)` and rename. The class itself does not need renaming.
- [x] 5.4 In `src/mcp/agent-public-row.ts`, update the row-projection function to map `agent_type` and `agent_type_name` (no longer `client`/`client_name`) into the public-row response. Make sure the legacy keys are NOT emitted.
- [x] 5.5 In `src/mcp/transport-dispatch.ts`, audit for `client` references and rename if they refer to the agent type (vs. MCP-client framing).
- [x] 5.6 In `src/mcp/poke.ts`, audit for any `client`-typed field references and rename.

## 6. Tests

- [x] 6.1 Mechanical sweep across `tests/`: replace `client: 'codex'` → `agent_type: 'codex'`, `client: 'claude-code'` → `agent_type: 'claude-code'`, `client: 'opencode'` → `agent_type: 'opencode'`, `client: 'custom'` → `agent_type: 'custom'`, `client_name:` → `agent_type_name:`. Use a single search-and-replace pass per file, then visually verify no false positives (e.g. comments referring to "MCP client" should NOT change).
- [x] 6.2 In `tests/agents-schema.test.ts`, update the column-list assertion to expect `agent_type` / `agent_type_name` (not `client` / `client_name`).
- [x] 6.3 Add a new test file `tests/rename-client-to-agent-type-migration.test.ts` covering the column-rename startup migration: (a) legacy schema migrates correctly with data preserved, (b) idempotency on already-renamed schema, (c) fresh database starts with renamed columns and no migration runs.
- [x] 6.4 Add a new test (in the same file or `tests/register-agent-tool-schema.test.ts`): legacy `client` and `client_name` keys produce unknown-key Zod errors with helpful rename hints in the message.
- [x] 6.5 Run `npx vitest run` and confirm all tests pass (excepting the pre-existing failures in `tests/proxy-reconnect.test.ts` and `tests/register-agent-hint.test.ts` documented in the previous change).

## 7. In-flight collapse-register-self-tools artifacts (per design D4)

If collapse is NOT yet archived when these tasks run, rewrite its artifacts in place so they use `agent_type` instead of `client`:

- [x] 7.1 Rewrite `openspec/changes/collapse-register-self-tools/proposal.md`: every `client="X"` → `agent_type="X"`, every `client_name` → `agent_type_name`.
- [x] 7.2 Rewrite `openspec/changes/collapse-register-self-tools/design.md` symmetrically.
- [x] 7.3 Rewrite `openspec/changes/collapse-register-self-tools/specs/agent-registry/spec.md`: every reference (in REMOVED migration notes, MODIFIED requirement bodies, ADDED requirement bodies, and all scenario text) renames.
- [x] 7.4 Rewrite `openspec/changes/collapse-register-self-tools/specs/mcp-transport/spec.md` symmetrically.
- [x] 7.5 Rewrite `openspec/changes/collapse-register-self-tools/tasks.md` symmetrically.
- [x] 7.6 Re-run `openspec validate collapse-register-self-tools --strict` after the rewrite.

If collapse IS already archived, this section is a no-op.

## 8. Documentation

- [x] 8.1 Update `README.md`: rename every `client:` / `client="X"` / `client_name:` reference in the Register section, the example call blocks, and the field reference table. Preserve all other content.
- [x] 8.2 Update `README.zh-CN.md` symmetrically.
- [x] 8.3 Update `docs/configs/claude-code.md` and `docs/configs/codex-cli.md`: rename field references, but keep narrative mentions of "MCP client" or "Claude Code as a client of the daemon" untouched (those refer to MCP-protocol "client", not the agent_type field).
- [x] 8.4 Add a `CHANGELOG.md` entry under `0.5.0` documenting the BREAKING rename: `client → agent_type`, `client_name → agent_type_name`, `ClientKind → AgentType` (TypeScript), `agents.client → agents.agent_type` and `agents.client_name → agents.agent_type_name` (storage with auto-migration), and the rejection of legacy field names with rename hints.

## 9. Sweep main spec for remaining client mentions (post-archive cleanup)

- [x] 9.1 After applying the spec deltas, sweep `openspec/specs/agent-registry/spec.md` for any remaining `client` / `client_name` references in requirements not directly modified by this change (scenarios that used `register_agent({client:'codex', ...})` as setup, etc.). Rename mechanically.
- [x] 9.2 Sweep `openspec/specs/claude-channel-transport/spec.md` for any `client` / `client_name` references and rename.
- [x] 9.3 Sweep `openspec/specs/mcp-transport/spec.md` for any references not already covered by collapse-change archival.
- [x] 9.4 Re-run `openspec validate --strict` on every modified main spec.

## 10. Version bump and final validation

- [x] 10.1 Bump `package.json` `version` to `0.5.0`.
- [x] 10.2 Run `npx tsc --noEmit` and confirm zero TypeScript errors.
- [x] 10.3 Run `npm run build` and confirm clean build.
- [x] 10.4 Run the full test suite (`npx vitest run`) and confirm all green (excepting documented pre-existing failures).
- [x] 10.5 Run `openspec validate rename-client-to-agent-type --strict` and confirm pass.
- [x] 10.6 Restart the local daemon (`kill <pid>` + `node dist/cli.js daemon --port 9100`); manual smoke test: `tools/list` shows `register_agent` description with `agent_type=` everywhere and no `client="X"` references; `register_agent({client: 'X', ...})` rejected with rename hint.
