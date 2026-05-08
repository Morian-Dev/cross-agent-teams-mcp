## 1. Sentinel migration in applySchema

- [x] 1.1 Add a `migrateAgentsCursorWatermark` step to `src/storage/schema.ts` that runs `UPDATE agents SET last_processed_event_id = COALESCE((SELECT MAX(event_id) FROM events), 0) WHERE last_processed_event_id = 0`. Wire it into `applySchema` after the existing column migrations
- [x] 1.2 Add a unit test under `tests/` covering: (a) zero cursor advances to MAX(event_id), (b) non-zero cursor is untouched, (c) empty events table leaves cursor at 0, (d) running the migration twice on the same db is a no-op the second time

## 2. register_agent fresh-INSERT cursor initialisation

- [x] 2.1 Locate the fresh-INSERT path in `src/mcp/register-agent.ts` (or its `AgentsRepo.upsert` helper in `src/storage/agents-repo.ts`) and change the new-row INSERT to set `last_processed_event_id = COALESCE((SELECT MAX(event_id) FROM events), 0)`. Keep the read inside the same SQLite transaction as the INSERT
- [x] 2.2 Verify the reuse path (existing `(team, name)` row) continues to preserve `last_processed_event_id` — no code change expected, but add an explicit assertion in the test harness
- [x] 2.3 Add tests covering: (a) fresh INSERT into a non-empty events table starts at MAX(event_id), (b) fresh INSERT into an empty events table starts at 0, (c) reuse path preserves an existing non-zero cursor, (d) role-change path preserves cursor (already covered by an existing scenario — make sure it still passes)

## 3. get_inbox stateful cursor

- [x] 3.1 In `src/mcp/get-inbox.ts`, change `since` resolution: when `args.since_event_id` is `undefined`, read `agents.last_processed_event_id` for the caller; when it is any explicit number (including `0`), use it as-is
- [x] 3.2 After computing `last_event_id`, when the call was the implicit-cursor path (i.e. `args.since_event_id` was `undefined`), execute `UPDATE agents SET last_processed_event_id = :last_event_id WHERE agent_id = :caller AND last_processed_event_id < :last_event_id` inside the same transaction as the SELECT
- [x] 3.3 Update the `get_inbox` MCP tool description in `src/mcp/tools.ts` to document: default behaviour advances the stored cursor; explicit `since_event_id` is read-only; offline forfeiture beyond 30 days
- [x] 3.4 Add tests covering: (a) default call advances cursor, (b) two consecutive default calls return new tail only, (c) default call with no new mail leaves cursor unchanged, (d) explicit `since_event_id: 0` returns history without advancing, (e) explicit `since_event_id: N` higher than stored cursor returns from N without regressing or advancing the stored cursor, (f) pagination (`limit` < total) advances cursor to the last *returned* event_id

## 4. runCleanup uniform 30-day TTL across three tables

- [x] 4.1 Rewrite `src/daemon/cleanup.ts` `runCleanup` to compute a single `ageCutoff = now - 30d` and execute three DELETEs inside one SQLite transaction, in order: `message_delivery_status` (by `message_id IN (SELECT id FROM messages WHERE sent_at < :ageCutoff)`), then `messages` (`WHERE sent_at < :ageCutoff`), then `events` (`WHERE created_at < :ageCutoff`). Drop the cursor-floor CTE and the `online_cursor` join entirely
- [x] 4.2 Make `runCleanup` return `{ deleted: number }` summing rows deleted across all three tables (not just events)
- [x] 4.3 Update `CleanupOpts.maxAgeDays` default to `30` (was `7`); keep the parameter so tests can override
- [x] 4.4 Add tests covering: (a) 31-day rows in all three tables are deleted in one transaction, (b) 29-day rows survive, (c) broadcast (3 messages sharing one event_id) deletes all 3 messages + 3 status rows + 1 event row, (d) cursor position is irrelevant — old rows are deleted regardless of `last_processed_event_id`, (e) `agents`, `tasks`, `contracts`, `contract_subscriptions` are untouched, (f) child→parent ordering: simulate FK-on and confirm no transient FK violation
- [x] 4.5 Confirm `src/daemon/server.ts` cleanup interval scheduling is unchanged and still calls the new `runCleanup` correctly (it already does — task is verification-only)

## 5. Spec / docs sync

- [x] 5.1 Run `openspec validate inbox-cursor-and-ttl --strict` and resolve any spec-format issues
- [x] 5.2 Run the full vitest suite `pnpm vitest run` and confirm green (554/555 pass; the single failure `tests/proxy-reconnect.test.ts` is a pre-existing flaky test documented as unrelated in `openspec/changes/archive/2026-04-30-collapse-register-self-tools/tasks.md` task 7.3 — fails on HEAD too without these changes)
