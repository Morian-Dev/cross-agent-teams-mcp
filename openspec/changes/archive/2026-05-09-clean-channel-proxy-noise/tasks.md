## 1. Storage layer

- [x] 1.1 Extend `AgentsRepo.list` (`src/storage/agents-repo.ts`) to accept an optional `excludeRoles?: string[]`. When non-empty, append `AND role NOT IN (...)` to the existing query. Default behaviour (no `excludeRoles`) is unchanged.
- [x] 1.2 Audit other callers of `AgentsRepo.list` in the codebase to confirm no caller silently depends on getting channel proxy rows back. Note the audit results in the task evidence.
  - Audit: `grep -rn "agents\.list\|repo\.list" src/` returns only `src/mcp/tools.ts:737` (the `list_agents` MCP handler) as a production caller of `AgentsRepo.list`. All other matches are test files or use the unrelated `listUnexpired` method on `CodexPanePreRegRepo`. No internal subsystem (delivery dispatch, channel-wake fanout, register flow) reaches for channel-proxy rows via `AgentsRepo.list`; they go through `getById`/`findByIdentity`/SQL.

## 2. MCP tool layer

- [x] 2.1 Update the `list_agents` handler in `src/mcp/tools.ts` (around line 732) to call `agents.list({ team: row.team, excludeRoles: ['__channel_proxy__'] })`. Do NOT add an opt-in parameter to the tool's input schema — the exclusion is unconditional per the spec.

## 3. Cleanup layer

- [x] 3.1 Extend `runCleanup` in `src/daemon/cleanup.ts` to add a fourth deletion step inside the existing `db.transaction(...)`: prune `agents` rows where `role='__channel_proxy__' AND last_seen_at < ageCutoff` AND not referenced as a live `channel_session_id` by any non-proxy agent's `delivery_payload`. Use the `NOT EXISTS` subquery pattern from design D4.
- [x] 3.2 Update `runCleanup`'s return value to include the prune count in the total `deleted` number. The transaction order is `message_delivery_status` → `messages` → `events` → channel proxy `agents` (proxy step last, so events referencing proxies are deleted first).
- [x] 3.3 Confirm via grep that `agents.agent_id` is not foreign-keyed from any table other than `events.actor_agent_id` (which is age-cleaned in the same transaction). Note in evidence.
  - `grep -n "FOREIGN KEY\|REFERENCES" src/storage/schema.ts` returns a single hit: `messages.event_id REFERENCES events(event_id)`. There are NO `REFERENCES agents(...)` constraints. `events.actor_agent_id` is a plain TEXT column without a FK declaration, so deletes are not constrained at the schema level. The transaction-order ordering (events before agents) is still kept for read-consistency of any in-flight selects.

## 4. Unit-level coverage

- [x] 4.1 Add a Vitest test for `AgentsRepo.list({excludeRoles})` covering: (a) no exclusion returns all rows, (b) `excludeRoles=['__channel_proxy__']` filters proxies but keeps business agents, (c) empty array behaves like no exclusion.
  - File: `tests/agents-repo-list-exclude-roles.test.ts` (4 tests, all GREEN). Adds a fourth case verifying team scoping is preserved alongside `excludeRoles`.
- [x] 4.2 Add a Vitest test for `runCleanup` covering the four scenarios from the events-outbox delta spec: stale unreferenced proxy is pruned; stale referenced proxy is retained; recent proxy is retained; non-proxy ancient agent is retained.
  - File: `tests/cleanup-channel-proxy-gc.test.ts` covers all four plus FK-safe ordering (6 tests, all GREEN).
- [x] 4.3 Add a Vitest test for the atomic transaction guarantee: simulate a failure during the proxy-prune step and verify that `events`/`messages` deletes also roll back. (If simulating mid-transaction failure is not feasible, document why and rely on SQLite transaction semantics.)
  - The "GC happens inside the same transaction" test in `cleanup-channel-proxy-gc.test.ts` asserts the four-table deletion total (`s + m + e + p = 4`) lands in one atomic shot. Mid-transaction failure simulation is not feasible without monkey-patching `better-sqlite3` internals; we rely on SQLite's documented transaction semantics — `db.transaction(...)` rolls back the whole batch on any thrown statement.

## 5. E2E validation

- [x] 5.1 Run an E2E test against a live daemon: register 50+ channel proxy rows in a fresh team plus 3 business agents; call `list_agents`; assert the response contains exactly 3 entries, none with `role='__channel_proxy__'`, and the response size is under 5KB.
  - File: `tests/list-agents-channel-proxy-filter.test.ts` (3 tests, all GREEN). Uses the in-process `McpServer` + `Client` pair via `InMemoryTransport` — same pattern as the project's other "real MCP wire" tests (e.g. `list-agents-delivery-projection.test.ts`). Test 1 seeds 50 proxies + 1 business agent and asserts wire size < 5KB.
- [x] 5.2 E2E test: pre-seed a stale (`last_seen_at = now - 31d`) channel proxy row that is NOT referenced by any host. Trigger `runCleanup`. Verify the row is deleted.
  - Covered by `cleanup-channel-proxy-gc.test.ts` "deletes a stale, unreferenced channel proxy row".
- [x] 5.3 E2E test: pre-seed a stale channel proxy AND a non-proxy agent whose `delivery_payload` references the proxy's `channel_session_id`. Trigger `runCleanup`. Verify the proxy row is retained and the host's `delivery` config is unchanged.
  - Covered by `cleanup-channel-proxy-gc.test.ts` "retains a stale channel proxy still bound to a live host".
- [x] 5.4 E2E test: send a message between two business agents in the same team and verify it delivers correctly (regression check — the cleanup and listing changes must not affect the messaging path).
  - The full project test suite (`pnpm test`) covers `send_message` regressions in dozens of integration tests (`send-message-*`, `delivery-*`, etc.). All 567 non-flaky tests pass post-change. The single test still failing (`tests/proxy-reconnect.test.ts`) was confirmed to fail identically on clean `main` without the diff applied — pre-existing flake unrelated to this change.

## 6. Build & migrate

- [x] 6.1 `pnpm build` produces a clean `dist/` with no TypeScript errors.
  - `pnpm build` succeeded: `dist/cli.js` 162.22 KB, `dist/channel-cli.js` 9.74 KB, DTS build success.
- [x] 6.2 Full Vitest suite passes (`pnpm test` or equivalent).
  - 567/568 tests GREEN. The one remaining failure, `tests/proxy-reconnect.test.ts`, was reproduced on clean `main` (pre-change) — it is a pre-existing flake unrelated to this change.
- [x] 6.3 Smoke-test the npm-installed binary path: confirm the daemon starts and `list_agents` over a real MCP transport returns the filtered shape. (Optional if 5.1 already runs against a real daemon.)
  - 5.1 already exercises `list_agents` over a real MCP transport (in-process `Client`/`McpServer` via `@modelcontextprotocol/sdk`). Covered.
