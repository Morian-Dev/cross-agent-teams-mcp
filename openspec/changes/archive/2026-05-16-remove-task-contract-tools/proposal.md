## Why

The `task_*` and `register_contract` / `subscribe_contract` families have never been used in practice.  Real cross-agent collaboration is negotiated by the agents themselves in chat — pinning a task-queue or contract-registry shape into the MCP tool surface adds maintenance cost (9 tools, 3 SQL tables, 11 test files, 3 specs) without buying anything.  Removing them shrinks the public surface to a tight "registration + messaging" core and clears the daemon database of unused tables.

## What Changes

- **BREAKING** Remove 9 MCP tools: `register_contract`, `subscribe_contract`, `get_contract`, `diff_contracts`, `pending_contract_events`, `task_add`, `task_claim`, `task_complete`, `task_list`.
- **BREAKING** Drop SQLite tables `tasks`, `contracts`, `contract_subscriptions` on first boot of the new version.
- **BREAKING** `unregister_self` no longer guards on in-progress tasks; it becomes a pure "delete agents row + drop channel/runtime subscriptions" operation and the `tasks_in_progress` error is removed from its response union.
- Remove `task_*` and `contract_*` event types from the events outbox cleanup contract; the outbox keeps only `agent_registered`, `send_message`, `broadcast`, `broadcast_to_role`, and channel/runtime infrastructure events.
- Remove the `contract_event` heartbeat scenario from `daemon-core`.
- Drop service files under `src/mcp/` for the 9 removed tools, plus the `listClaimedInProgressTaskIds` helper on `agents-repo`.
- Delete 11 task / contract test files under `tests/` and any stray task/contract assertions in surviving tests.
- Remove `openspec/specs/task-list/`, `openspec/specs/contract-registry/`, `openspec/specs/contract-subscriptions/`.
- Strip task/contract sections from `README.md`, `README.zh-CN.md`, `AGENTS.md`, and `docs/`.  `CHANGELOG.md` gets a **BREAKING** entry.
- Retained tools (unchanged semantics): `register_agent`, `unregister_self`, `list_agents`, `bind_runtime_identity`, `bind_channel`, `detect_tmux_pane`, `pre_register_codex_pane`, `subscribe_channel_wake`, `send_message`, `send_message_by_id`, `broadcast`, `broadcast_to_role`, `get_inbox`, `get_delivery_status`, `echo`.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `agent-registry`: `unregister_self` drops the `tasks_in_progress` short-circuit; the in-progress-tasks scenario and `tasks_in_progress` error variant are removed.
- `events-outbox`: cleanup-survival contract no longer references `tasks`, `contracts`, or `contract_subscriptions` tables; outbox event-type enumeration drops `contract_registered` / `task_added` / `task_claimed` / `task_completed`.
- `daemon-core`: heartbeat scenario referencing `contract_event` delivery is removed.
- `mailbox`: the requirement pinning `task_add` to a pure task-list mutation is removed (no more `task_add`).
- `contract-registry`: capability removed in full.
- `contract-subscriptions`: capability removed in full.
- `task-list`: capability removed in full.

## Impact

- **MCP API surface** shrinks by 9 tools.  Any external caller relying on `task_*` / `*_contract` tools breaks; documented as **BREAKING** in CHANGELOG with no shim.
- **SQLite schema** loses 3 tables on first boot of the new version.  Existing data in those tables is discarded — acceptable because the features were unused; no migration path is offered.
- **Tests**: `tests/task-*.test.ts`, `tests/contract-*.test.ts`, `tests/register-contract*.test.ts`, `tests/subscribe-contract.test.ts`, `tests/get-contract.test.ts`, `tests/pending-contract-events.test.ts`, `tests/tasks-add.test.ts` are deleted; survivors that mention task/contract are scrubbed.
- **`src/mcp/`** loses 9 service files plus the matching `registerTool(...)` blocks in `tools.ts`.
- **`src/storage/`** loses the 3 table-creation statements in `schema.ts` plus the task-related helpers in `agents-repo.ts`.
- **Docs**: README (both locales), AGENTS.md, and the relevant `docs/` pages lose their task/contract sections.
- **Version**: this is a breaking change.  Implementation may choose between `1.0.0` (commits to "daemon-only + broadcast/p2p" as the stable surface) or `0.6.0` with a loud BREAKING marker; either is acceptable but CHANGELOG MUST flag breakage.
- **Out of scope**: surviving tools keep their existing parameter and response shapes; daemon transport layer, channel/runtime identity, and tmux pane binding are untouched.
