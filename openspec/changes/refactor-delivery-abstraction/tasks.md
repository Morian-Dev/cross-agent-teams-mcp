## 1. Types and validator

- [x] 1.1 Define `DeliverySpec` discriminated union in a new module (e.g. `src/lib/delivery-spec.ts`) with kinds `'none'`, `'claude-channel'`, `'codex-appserver'`
- [x] 1.2 Implement `parseDeliveryRow(row: { delivery_kind, delivery_payload }): DeliverySpec` with `corrupt_delivery_payload` error on parse failure
- [x] 1.3 Implement `serializeDelivery(spec: DeliverySpec): { delivery_kind, delivery_payload }` inverse of 1.2
- [x] 1.4 Implement `validateDeliveryForWrite(input): { ok: DeliverySpec } | { error: 'invalid_delivery', reason }` accepting `none` and `claude-channel` only; rejecting `codex-appserver` with reason `kind_not_yet_supported` and any other kind with `unknown_kind`
- [x] 1.5 Unit tests in `tests/delivery-spec.test.ts` covering serialize / parse roundtrip for each kind, corrupt payload, and validator accept/reject cases from `agent-delivery/spec.md`

## 2. Storage schema and migration

- [x] 2.1 Update `src/storage/schema.ts` to include `delivery_kind TEXT NOT NULL DEFAULT 'none'` and `delivery_payload TEXT` in the `CREATE TABLE agents` statement for fresh databases
- [x] 2.2 Add idempotent startup migration in the schema bootstrap path: detect missing columns via `PRAGMA table_info('agents')`, run `ALTER TABLE agents ADD COLUMN delivery_kind ...` and `ALTER TABLE agents ADD COLUMN delivery_payload TEXT` only when missing, wrapped in a transaction
- [x] 2.3 Add one-shot backfill in the same migration: `UPDATE agents SET delivery_kind='claude-channel', delivery_payload=json_object('channel_session_id', channel_session_id) WHERE channel_session_id IS NOT NULL AND delivery_kind='none'`
- [x] 2.4 Verify migration leaves legacy `channel_session_id` column and its values untouched
- [x] 2.5 Tests: fresh-db schema assertions (PRAGMA table_info columns, defaults, notnull flags) matching scenarios in `agent-registry/spec.md`
- [x] 2.6 Tests: migration-from-old-schema — seed a DB that lacks `delivery_*` columns but has rows with `channel_session_id`, run startup, assert columns exist and backfill applied exactly to matching rows
- [ ] 2.7 Tests: migration idempotence — run startup twice, assert second run does no ALTER and does not overwrite values

## 3. AgentsRepo: delivery read / write

- [ ] 3.1 Extend `AgentsRepo.register(...)` (in `src/storage/agents-repo.ts`) to accept `delivery?: DeliverySpec`; default to `{kind: 'none'}` when omitted
- [ ] 3.2 Add `AgentsRepo.setDelivery(agent_id, spec: DeliverySpec): void` that runs the `UPDATE agents SET delivery_kind=?, delivery_payload=? WHERE agent_id=?` statement atomically using `serializeDelivery`
- [ ] 3.3 Update `AgentsRepo` read methods (`getById`, `list`, any `list_agents` backing query) to return rows with the reconstructed `delivery: DeliverySpec` field via `parseDeliveryRow`
- [ ] 3.4 Add a `channel_session_id` derived accessor in the row-shape exposed by `AgentsRepo` (equals `delivery.channel_session_id` when `kind === 'claude-channel'`, else `null`)
- [ ] 3.5 Audit all AgentsRepo SQL to confirm no statement writes directly to the legacy `channel_session_id` column after this change; grep `channel_session_id\\s*=` inside `agents-repo.ts` should return zero matches in write paths
- [ ] 3.6 Tests: `tests/agents-repo-delivery.test.ts` — register with each supported kind, read back, assert delivery shape; `setDelivery` overwrite semantics; derived `channel_session_id` getter correctness

## 4. register_agent MCP tool

- [ ] 4.1 Extend input schema of `register_agent` (in `src/mcp/register-agent.ts` and zod schema in `src/mcp/tools.ts` or equivalent) with optional `delivery` field matching `DeliverySpec`
- [ ] 4.2 Before the repo call, validate `delivery` with `validateDeliveryForWrite`; on failure return `{error: 'invalid_delivery', reason}` without DB write
- [ ] 4.3 On success, pass the validated `DeliverySpec` to `AgentsRepo.register` so identity + delivery are persisted atomically
- [ ] 4.4 Ensure existing re-registration semantics (idempotent for same `(team, name)`) preserve any previously-persisted non-`none` delivery when the new call omits `delivery`
- [ ] 4.5 Tests: `tests/register-agent-delivery.test.ts` — register without delivery (asserts `kind='none'`); register with `claude-channel` delivery (asserts row has both identity + delivery atomically); register with invalid `claude-channel` (missing `channel_session_id`) returns error and writes no row; register with `codex-appserver` returns `kind_not_yet_supported`

## 5. bind_channel MCP tool: underlying write path

- [ ] 5.1 Change `bind_channel` handler so step 5 (on all prior validations passing) calls `AgentsRepo.setDelivery(caller_agent_id, {kind: 'claude-channel', channel_session_id})` instead of direct `UPDATE agents SET channel_session_id = ...`
- [ ] 5.2 Confirm response schema (`{ok: true}` / `{error: ...}`) and error codes (`unknown_agent`, `forbidden_role`, `invalid_channel_session_id`, `unknown_channel_session`) are unchanged
- [ ] 5.3 Update existing `tests/bind-channel.test.ts` assertions: after successful bind, check `delivery_kind='claude-channel'` and parsed `delivery_payload.channel_session_id` instead of legacy column
- [ ] 5.4 Add a test that asserts the legacy `channel_session_id` column is left at its pre-call value after successful bind (confirms no direct write)

## 6. list_agents MCP tool

- [ ] 6.1 Update `list_agents` handler to include the `delivery: DeliverySpec` field in each entry of its response
- [ ] 6.2 Keep the existing `channel_session_id: string | null` field in each entry, sourced from the derived accessor (not from a direct column read)
- [ ] 6.3 Tests: update `tests/agents-repo-list-channel-session-id.test.ts` and any `list_agents` tests to assert both fields; add scenarios matching `agent-registry/spec.md` MODIFIED requirement ("list_agents returns channel_session_id field")

## 7. Daemon poke dispatcher routing

- [ ] 7.1 Locate the existing dispatcher code path that reads `channel_session_id` before selecting `ChannelWakeFanout` vs tmux fallback (likely in the send-message / poke handlers)
- [ ] 7.2 Replace the read with a `DeliverySpec` switch on `kind`:
  - `'claude-channel'` → existing `ChannelWakeFanout` dispatch using `delivery.channel_session_id`
  - `'none'` → tmux fallback if `tmux_pane_id` set, else `no_transport_available`
  - `'codex-appserver'` → return `{error: 'dispatcher_not_implemented'}` with a warning log
- [ ] 7.3 Tests: `tests/poke-dispatch-routing.test.ts` covering each case from `agent-delivery/spec.md` "Poke dispatch routes by delivery.kind"

## 8. Audit sweeps and cleanup

- [ ] 8.1 Grep codebase for remaining direct reads of the legacy `channel_session_id` column outside AgentsRepo; migrate to `delivery`-based access or the derived accessor
- [ ] 8.2 Grep codebase for remaining writes (`UPDATE agents SET channel_session_id` or `INSERT INTO agents (... channel_session_id ...)`) — expected count: 0 in daemon code after this change (test fixtures may still seed the legacy column directly to exercise migration)
- [ ] 8.3 Add a lint-style test (`tests/no-direct-channel-column-writes.test.ts`) that statically scans `src/**/*.ts` for `UPDATE agents SET channel_session_id` to prevent regressions

## 9. Backward compatibility smoke

- [ ] 9.1 Start a daemon built from this change against an `agents` table seeded with the old schema (only `channel_session_id`, no `delivery_*`); assert it bootstraps cleanly and migrates without data loss
- [ ] 9.2 Exercise a full Claude channel round-trip (proxy starts → subscribe_channel_wake → bind_channel → poke delivered to proxy) against the migrated DB to confirm the claude-channel path still works end-to-end

## 10. Full test suite and validation

- [ ] 10.1 Run `pnpm test` and confirm all suites pass
- [ ] 10.2 Run `pnpm typecheck` and confirm no type errors
- [ ] 10.3 Run `openspec validate refactor-delivery-abstraction` and confirm it is valid
