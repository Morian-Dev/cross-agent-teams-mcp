## Why

`get_inbox` is currently stateless and `agents.last_processed_event_id` is never written by any production code path. Result: agents that lose conversation context (compaction, restart, /clear) re-read the entire mailbox history on every cold call. Compounding this, `runCleanup` only deletes from `events` and is gated by the always-zero cursor floor, so messages, delivery statuses, and events have never actually been pruned in production — the SQLite file grows monotonically.

## What Changes

- **BREAKING** (semantic) `get_inbox` default behaviour: when `since_event_id` is omitted, the daemon SHALL read the caller's stored `last_processed_event_id` instead of `0`, and SHALL advance that column to `last_event_id` after a successful read.
- Re-read / debug path preserved: callers MAY still pass an explicit `since_event_id` (including `0`) to override the stored cursor; an explicit value SHALL NOT trigger advancement (read-only inspection).
- `register_agent` SHALL initialise `last_processed_event_id` to the current `MAX(event_id)` for genuinely new agent rows, so freshly-registered agents do not see historical mail addressed to anyone.
- One-shot sentinel migration on schema apply: `UPDATE agents SET last_processed_event_id = COALESCE((SELECT MAX(event_id) FROM events), 0) WHERE last_processed_event_id = 0`. Idempotent — once advanced, never reset.
- **BREAKING** `runCleanup` retention policy: replace the 7-day events TTL + cursor-floor logic with a uniform **30-day hard TTL** that deletes from `message_delivery_status`, `messages`, and `events` in a single transaction (child→parent order). Cursor-floor protection is removed — 30 days is treated as a forfeiture window for offline agents.
- Existing-row upsert (re-register of a known `(team, name)`) continues to preserve `last_processed_event_id` — only fresh inserts get the MAX initialisation.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `mailbox`: `get_inbox` becomes stateful (server-side cursor with auto-advance + explicit override for re-read); adds 30-day message retention coupled to events cleanup.
- `events-outbox`: replace 7-day cursor-gated events cleanup with a 30-day hard cleanup that also prunes `messages` and `message_delivery_status`.
- `agent-registry`: `register_agent` MUST initialise `last_processed_event_id` to `MAX(event_id)` for new rows; one-shot sentinel migration brings legacy rows up to that watermark.

## Impact

- Code: `src/mcp/get-inbox.ts`, `src/mcp/register-agent.ts`, `src/mcp/tools.ts` (description), `src/storage/schema.ts` (sentinel migration), `src/daemon/cleanup.ts` (multi-table delete, 30d TTL).
- Schema: no DDL changes — only behavioural changes around the existing `last_processed_event_id` column.
- Data: on first daemon boot post-deploy, all in-flight agents have their cursor advanced to current `MAX(event_id)` (one-shot, idempotent). All `messages`, `message_delivery_status`, and `events` rows older than 30 days will be deleted by the next cleanup tick.
- Tests: cursor advance + explicit override + sentinel migration idempotence + multi-table TTL transaction order + cleanup interval still honoured.
- No new MCP tools, no new schema columns, no new tables.
