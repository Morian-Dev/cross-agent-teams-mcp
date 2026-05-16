# Changelog

## Unreleased

### BREAKING

- Removed 9 MCP tools: `register_contract`, `subscribe_contract`, `get_contract`, `diff_contracts`, `pending_contract_events`, `task_add`, `task_claim`, `task_complete`, and `task_list`.
- Removed the unused task/contract storage surface.  On startup, legacy SQLite tables `tasks`, `contracts`, and `contract_subscriptions` are dropped with `DROP TABLE IF EXISTS`.
- `unregister_self` no longer checks for in-progress tasks and no longer returns the `tasks_in_progress` error branch.

## 0.5.1

### Fixed

- **Daemon session leak (OOM in ~20 min under multi-host load).**  Three layered fixes target the feedback loop where channel-proxy reconnects accumulated phantom MCP sessions on the daemon side:
  - `register_agent` cross-session re-claim of an existing `(team, name)` is now a TAKEOVER instead of returning `{ error: 'agent_id_collision' }`.  The daemon force-closes the prior MCP transport, releases the binding, and accepts the new registration.  The within-session Authorization-mismatch HTTP 409 path is preserved.  Existing in-memory bindings move to the new session id; SSE fanout, channel-wake fanout, and Authorization-hash bindings are detached via the existing `transport.onclose` chain.
  - `mountMcp` adds an orphan-session GC that force-closes any session whose `agentIdHolder.current === undefined` and `Date.now() - createdAt >= 60_000`.  Sessions that completed `register_agent` are NEVER touched.  The ticker runs in `buildServer` next to the existing cleanup ticker; default tick 60 s, configurable via `opts.orphanGcIntervalMs` and env `ORPHAN_GC_INTERVAL_MS`.
  - Channel proxy `waitForDisconnect` default heartbeat raised from 200 ms to 30 000 ms.  `transport.onclose` remains the primary disconnect signal; echo polling is now a coarse-grained backstop.  Override stays available via `ReconnectingProxyConfig.healthCheckIntervalMs` for tests.

### Migration

- API consumers that previously relied on `agent_id_collision` as a guard against double-registration MUST treat the second `register_agent` from a different MCP session as a takeover that returns the (existing) `agent_id` and assume the prior session is closed.

## 0.5.0

### BREAKING

- Renamed the `register_agent` input field `client` → `agent_type` and `client_name` → `agent_type_name`.  The Zod schema strictly rejects the legacy keys with a rename hint (`Unrecognized key in register_agent input. Note: the fields ``client`` and ``client_name`` were renamed to ``agent_type`` and ``agent_type_name`` in 0.5.0.`).  Migration: rename the field name at every call site.  The string enum values (`'codex' | 'claude-code' | 'opencode' | 'custom'`) are unchanged.
- Renamed the `agents` table columns: `agents.client` → `agents.agent_type`, `agents.client_name` → `agents.agent_type_name`.  An idempotent startup migration uses `ALTER TABLE agents RENAME COLUMN` to migrate legacy databases in place; existing data is preserved.  Fresh databases are created directly with the new column names.
- Renamed the exported TypeScript type `ClientKind` → `AgentType` (file moved from `src/lib/client-kind.ts` to `src/lib/agent-type.ts`).  The string union members are unchanged.
- Renamed the `list_agents` response keys `client` / `client_name` → `agent_type` / `agent_type_name` to mirror the input rename.  Other response keys are unchanged.
- Updated the `register_agent` tool description, MCP `serverInfo.instructions` string, and the bind-channel/pre-register-codex-pane tool descriptions to use `agent_type=` everywhere `client=` previously appeared.  The error envelope code stays `ui_pid_client_mismatch` for backwards-compatibility with existing handlers, but its detail string now reads `agent_type="..."`.
- The MCP tool field name on `detect_tmux_pane({agent})` and `bind_runtime_identity({agent})` STAYS `agent` — only the internal TypeScript type alias renames to `AgentType`.  No wire-format change for those two tools.
- Bumped to `0.5.0` (after `0.4.0`'s collapse-register-self-tools); under 0.x a minor bump signals a breaking change in this codebase's npm publish line.

### Internal

- `AgentsRepo.setClient(...)` renamed to `AgentsRepo.setAgentType(...)`.
- `RegisterInput` and `AgentRow` interfaces in `src/storage/agents-repo.ts` and `src/mcp/register-agent.ts` use `agent_type` / `agent_type_name` instead of `client` / `client_name`.
- All affected tests (~40 files referencing the field on the MCP tool surface or the SQLite column) were updated mechanically.  A new test file `tests/rename-client-to-agent-type-migration.test.ts` covers the column-rename startup migration (legacy schema → renamed, idempotency on already-renamed schema, fresh database).  Two new test cases in `tests/register-agent-tool-schema.test.ts` cover the legacy-key rejection paths.

## 0.4.0

### BREAKING

- Removed the `register_claude_self` MCP tool.  Migration: call `register_agent({ client: "claude-code", ... })` with the same arguments.  All behaviors (model auto-default via session client info, channel auto-bind via `ui_pid`, csid-vs-ui_pid consistency check) are preserved on the unified entry point.
- Removed the `register_codex_self` MCP tool.  Migration: call `register_agent({ client: "codex", thread_id, ... })`.  `thread_id` is now REQUIRED at the schema layer when `client="codex"`; missing or empty `thread_id` is rejected by Zod before any handshake runs.  The previous `thread_id_required` candidate-list envelope is no longer returned on the unified surface — launcher pre-reg callers should use `pre_register_codex_pane`.
- The `register_agent` tool description now contains a top-level DETECTION block instructing LLM callers to mechanically determine `client=` via shell probes — only `CODEX_THREAD_ID` (codex) and `CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT` (claude-code) are promoted as active probes; everything else falls through to `client="custom"` + `client_name`.  The previously promoted `command -v opencode` probe was removed because it detects what the user installed, not what runtime the LLM is inside (in field testing it caused cursor to misregister as opencode).  `CURSOR_TRACE_ID` is mentioned only as an in-line example for choosing `client_name="cursor"` under the custom fallback, not as a separate probe.
- The MCP `serverInfo.instructions` string was rewritten to describe `register_agent` only and includes the same anti-pattern warning ("do NOT guess from system-wide signals like 'binary X is on PATH'").
- `model` is now OPTIONAL for any `client` kind.  The previous schema rejection of `model === undefined` for non-claude / non-codex clients was removed; `agents.model` stores NULL when omitted.  Pass `model` only when you have an authoritative identifier you want surfaced via `list_agents`.

### Internal

- `RegisterCodexSelfService` continues to back the codex-appserver registration path inside `executeRegister` for `register_agent({ client: "codex", thread_id, ... })`.  Only the MCP-tool wrapper was removed.
- `defaultClaudeSelfModel` and the codex `ws_url=""` default were inlined into `executeRegister`, gated on `client`.
- `RegisterInput` (in both `src/mcp/register-agent.ts` and `src/storage/agents-repo.ts`) widened `model: string` to `model?: string` so the optional path can flow through to the SQLite INSERT (which binds NULL for an undefined value).
