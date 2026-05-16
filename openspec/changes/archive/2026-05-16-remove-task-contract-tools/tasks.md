## 1. Storage layer

- [x] 1.1 In `src/storage/schema.ts`, remove the `CREATE TABLE IF NOT EXISTS tasks`, `CREATE TABLE IF NOT EXISTS contracts`, and `CREATE TABLE IF NOT EXISTS contract_subscriptions` statements (plus any associated indexes).
- [x] 1.2 In `src/storage/schema.ts`, add an idempotent boot step that executes `DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS contracts; DROP TABLE IF EXISTS contract_subscriptions;` once after the current-version `CREATE TABLE` statements complete.
- [x] 1.3 In `src/storage/agents-repo.ts`, delete `listClaimedInProgressTaskIds` and any other helpers whose only callers are removed task/contract services.
- [x] 1.4 In `src/storage/events-outbox.ts`, remove `task_added` / `task_claimed` / `task_completed` / `contract_registered` from any event-type enums, type unions, or write-side switch tables. Reading legacy rows of those types remains safe (the cleanup TTL handles them); no consumer reads them post-removal.

## 2. MCP service files

- [x] 2.1 Delete `src/mcp/task-add.ts`, `src/mcp/task-claim.ts`, `src/mcp/task-complete.ts`, `src/mcp/task-list.ts`.
- [x] 2.2 Delete `src/mcp/register-contract.ts`, `src/mcp/subscribe-contract.ts`, `src/mcp/get-contract.ts`, `src/mcp/diff-contracts.ts`, `src/mcp/pending-contract-events.ts`.
- [x] 2.3 In `src/mcp/tools.ts`, remove the imports and `registerTool(...)` blocks for all 9 removed tools, plus the service-instance constructions (`TaskAddService`, `TaskClaimService`, `TaskCompleteService`, `TaskListService`, and any contract services if they are constructed there).
- [x] 2.4 In `src/mcp/unregister-self.ts`, remove the `tasks_in_progress` short-circuit and the `task_ids` branch of the response union. The remaining flow MUST be: load caller agent → if missing return `unknown_agent` → delete `agents` row + release session binding → return `{ ok: true, team, name, agent_id }`.
- [x] 2.5 Grep `src/` for stray references to removed services / table names / event types and clean them up.

## 3. Tests

- [x] 3.1 Delete the 11 dedicated test files: `tests/task-claim.test.ts`, `tests/task-complete.test.ts`, `tests/task-list.test.ts`, `tests/tasks-add.test.ts`, `tests/contract-diff.test.ts`, `tests/contracts-schema.test.ts`, `tests/get-contract.test.ts`, `tests/pending-contract-events.test.ts`, `tests/register-contract.test.ts`, `tests/register-contract-concurrent.test.ts`, `tests/subscribe-contract.test.ts`.
- [x] 3.2 In surviving tests under `tests/`, grep for `task_add`, `task_claim`, `task_complete`, `task_list`, `register_contract`, `subscribe_contract`, `get_contract`, `diff_contracts`, `pending_contract_events`, `tasks_in_progress`, `listClaimedInProgressTaskIds`, `contract_registered`, `task_added`, `task_claimed`, `task_completed`, `contract_event`, and remove or rewrite any cases that depend on the removed surface. Do NOT introduce `.skip` / `xfail` markers.
- [x] 3.3 Update `tests/agents-schema.test.ts` (and any analogous schema test) so it asserts that `tasks`, `contracts`, and `contract_subscriptions` do NOT exist after boot.
- [x] 3.4 Add a test under `tests/` covering the new boot-time drop scenario from `daemon-core` ("Upgrade from prior version drops legacy tables"): seed a DB with the three legacy tables + sample rows, boot the daemon, assert the tables are gone.
- [x] 3.5 Update / shrink `tests/agents-repo.test.ts` so it no longer exercises `listClaimedInProgressTaskIds`.
- [ ] 3.6 Run `pnpm test` (or equivalent) and confirm zero failures, zero skipped tests introduced by this change.

## 4. Documentation

- [x] 4.1 In `README.md` and `README.zh-CN.md`, delete every section / table row that describes `task_*` or `*_contract` tools. The "Tools" listing MUST end at the 15 surviving tools.
- [x] 4.2 In `AGENTS.md`, delete the contract / task playbook sections.
- [x] 4.3 Under `docs/`, remove or trim every page that describes `task_*` or `*_contract` workflows. If a page is mostly about removed features, delete it; if it's a mixed page, trim the relevant sections.
- [x] 4.4 In `CHANGELOG.md`, add a top entry titled "Unreleased" (or the chosen version) clearly marked **BREAKING**, listing every removed tool plus the schema impact ("legacy `tasks`, `contracts`, `contract_subscriptions` SQLite tables are dropped on first boot").

## 5. OpenSpec sync

- [ ] 5.1 After implementation + verify pass, run the standard sync/archive flow (`openspec sync` then `openspec archive remove-task-contract-tools`) so that `openspec/specs/task-list/`, `openspec/specs/contract-registry/`, `openspec/specs/contract-subscriptions/` are deleted from main specs and the modified specs (`agent-registry`, `events-outbox`, `daemon-core`, `mailbox`) absorb the deltas. This task is the last one; it MUST run only after `pnpm test` is green and the change is otherwise complete.

## 6. Manual verification

- [ ] 6.1 Build a release tarball (`pnpm pack` or equivalent) and confirm that `dist/` no longer contains the 9 removed service files.
- [ ] 6.2 Boot the daemon against a copy of a real `data.db` (with the three legacy tables present) and confirm that the tables are gone afterwards, that `data.db` size shrank, and that all surviving tools still respond.
- [ ] 6.3 Issue a `tools/list` MCP call against the running daemon and confirm exactly 15 tools are advertised (`register_agent`, `unregister_self`, `list_agents`, `bind_runtime_identity`, `bind_channel`, `detect_tmux_pane`, `pre_register_codex_pane`, `subscribe_channel_wake`, `send_message`, `send_message_by_id`, `broadcast`, `broadcast_to_role`, `get_inbox`, `get_delivery_status`, `echo`).
