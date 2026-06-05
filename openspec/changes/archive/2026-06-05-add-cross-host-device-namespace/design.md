## Context

Today's daemon is single-host: it binds `127.0.0.1`, identity is `(team, name)`, and the channel-cli proxy assumes both the proxy and the Claude Code UI it speaks to live on the daemon's machine.  Two teammates collaborating from separate machines have no supported path.

The channel-cli is already structured as a relay: it holds an SSE subscription to the daemon and signals a local PID on wake-up.  If we let it run on a peer host, poke delivery survives intact — the relay's "last mile" (signal local PID) still happens on the peer's box.  This is far cheaper than two-daemon federation, but it forces us to namespace agent identity by device because both hosts may have a `creator` agent.

## Goals / Non-Goals

**Goals:**
- Let a peer host run `cross-agent-teams-channel` against the daemon over LAN with bearer auth, preserving poke delivery.
- Give every agent a `device` label and resolve `name` / `name:device` from the caller's perspective so host-a and host-b can each say `creator` and mean their own.
- Keep the model symmetric: the rule is "caller-relative", independent of where the daemon physically runs.
- Migrate existing data and old loopback clients without surprises.

**Non-Goals:**
- Daemon-to-daemon federation, multi-master replication, CRDTs.
- Per-agent or per-user auth (we keep one shared bearer token).
- Whitelist / approval flow for remote device labels.
- Exposing `origin` / `remote_addr` to user-visible tools.
- Changes to `send_message_by_id` (UUIDs are globally unique already).
- Changes to `contracts` / `task_*` semantics (they are team-scoped and inherit device-transparency automatically).

## Decisions

### D1: Two orthogonal axes — `origin` (network-locality) vs `device` (naming)

We split the "local vs remote" idea into two concepts that the earlier exploration round had conflated:

- **`origin: 'local' | 'remote'`** is observed by the daemon at the socket layer (loopback ⇒ local).  It is unforgeable for that hop and used only for daemon-internal safety decisions: enforcing the "you cannot spoof the local device label from a remote socket", refusing non-loopback binds without a token, and recording `remote_addr` for audit.
- **`device: string`** is the caller-relative naming axis.  It is self-declared by callers (subject to origin-based guards) and is the only thing users / agents see.

`origin` is never returned by any tool.  Users see only `device`.

**Alternative considered**: a single `origin` field doing both safety and namespacing.  Rejected because the symmetric naming the user wants ("host-b's `creator` means host-b's local agent, even though it's `remote` from the daemon's view") requires the namespacing axis to follow the caller, not the daemon.

### D2: Identity key `(device, team, name)`, additive migration

Add two columns: `device TEXT NOT NULL` and `remote_addr TEXT NULL`.  Rebuild `agents_identity_idx` as `UNIQUE(device, team, name)`.

Migration sequence (executed in one transaction at daemon startup, idempotent):

1. `ALTER TABLE agents ADD COLUMN device TEXT` if missing.
2. `ALTER TABLE agents ADD COLUMN remote_addr TEXT` if missing.
3. Backfill `UPDATE agents SET device = <daemon's local label> WHERE device IS NULL`.
4. Recreate identity index: `DROP INDEX IF EXISTS agents_identity_idx; CREATE UNIQUE INDEX agents_identity_idx ON agents(device, team, name)`.

After step 3, change the column to `NOT NULL` via `CREATE TABLE ... AS SELECT` only if SQLite refuses the in-place alter; for SQLite ≥3.25 we rely on `CREATE UNIQUE INDEX` enforcement plus application-level NOT NULL checks (cheaper and matches existing patterns).

The daemon refuses to start the migration if any existing row's `name` contains `:` (sanity check; current data has none).

**Alternative considered**: a brand-new table with reshuffled columns.  Rejected — additive migration is the project convention (cf. the `claude_ui_pid` migration in `agent-registry`).

### D3: Origin tagging via Fastify `onRequest` hook + session-bound stash

Add an `onRequest` hook (after the existing auth hook) that:

- Extracts `req.socket.remoteAddress`.
- Classifies: `127.0.0.0/8`, `::1`, `::ffff:127.x.x.x` ⇒ `local`; anything else ⇒ `remote`.
- For `POST /mcp` with a known `Mcp-Session-Id`, stashes `{ origin, remote_addr }` on the session record.

`register_agent` reads the stash from its current session.  Other tools do not need it (origin only matters at registration time and for the channel-cli wake-up rules, which are also keyed on the proxy row that already carries `device`).

**Alternative considered**: pass origin/peer through every tool handler signature.  Rejected — too invasive; session-bound stash matches how `connection_id` is already threaded.

### D4: Register guards by origin

```
register_agent({device?, name, ...}) from session with {origin, ...}

if origin === 'local':
    if device is provided and device !== daemon.local_label:
        error: device_spoofing_from_loopback
    effective_device = daemon.local_label

elif origin === 'remote':
    if device is missing or empty:
        error: device_required_from_remote
    if device === daemon.local_label:
        error: device_spoofing_local_label_from_remote
    if device contains ':' or len(device) > 64:
        error: invalid_device_label
    effective_device = device

if name contains ':':
    error: invalid_name_label
```

The error names are wire-stable; the existing test pattern (`tests/register-agent-*.test.ts`) covers similar shapes.

### D5: `name:device` parsing in mailbox

The parser splits on the first `:` (we have already forbidden `:` inside name and device, so the first `:` is unambiguous).  Resolution:

```
parse(to_agent_name) →
    if no ':': (name = to_agent_name, device = caller.device)
    else:      (name, device) = split

resolved_team = to_team ?? caller.team
findByIdentity({ device, team: resolved_team, name })
```

`unknown_recipient` is returned by `findByIdentity` returning `undefined` (unchanged contract — only the lookup tuple widens).

`broadcast` enumerates `agents WHERE team = caller.team AND role != '__channel_proxy__'` across all devices (drops the implicit device filter that today's behavior would acquire after the schema change — without an explicit cross-device scope, broadcasts would silently miss remote teammates).

### D6: Channel-proxy auto-bind keyed on `(device, claude_ui_pid)`

`auto-bind-channel.ts` today matches live channel-proxy rows by `claude_ui_pid` alone.  PIDs are not unique across machines.  We extend the match to `(device, claude_ui_pid)`.

This means a Claude Code host calling `register_agent({agent_type:'claude-code', ui_pid: N})`:

- The daemon resolves the caller's `effective_device` (D4).
- It looks for a `__channel_proxy__` row with `(device = effective_device, claude_ui_pid = N)`.
- On hit, it auto-binds the resulting `delivery.channel_session_id`.

For a remote Claude Code paired with a remote channel-cli on the same peer host, both rows carry the peer's device label → the match works.

### D7: channel-cli ergonomics

`cross-agent-teams-channel` accepts:

- `--token <t>` / `CROSS_AGENT_TEAMS_MCP_TOKEN` — sent as `Authorization: Bearer <token>` on every Streamable HTTP request.
- `--device <label>` — defaults to `os.hostname()` lowercased with non-`[a-z0-9_-]` chars replaced by `-` (same normalizer as the daemon's default).  Passed into the proxy's `register_agent` upsert.

The hostname default keeps the existing local-host workflow zero-config (no flag needed); cross-host users typically already need `--daemon-url` and `--token`, adding `--device` to that command is a minor extra.

### D8: `--host` / `--token` startup safety net

`cli.ts` parses `--host`.  Before `startServer`, it normalizes the address:

- IPv4 loopback: `127.0.0.0/8`.
- IPv6 loopback: `::1`, `::ffff:127.0.0.0/8`.
- Unix socket / `localhost` → resolved and classified the same way.

If non-loopback AND `--token` is missing → `process.exit(1)` with stderr `token_required_for_non_loopback_bind`.

Token presence is the minimum safety bar; we explicitly do NOT add IP allowlists, TLS, or per-agent auth — those belong in a later change if the LAN model proves insufficient.

## Risks / Trade-offs

- **Risk**: a remote channel-cli could lie about its `device` label and register agents under any non-local-label name → confusion in `list_agents`.
  **Mitigation**: documentation calls out that device labels are a coordination convention; daemon refuses only the spoof of the local label.  This matches the existing trust model (one shared token = everyone with the token is trusted).
- **Risk**: PID collisions are still possible if two channel-clis on the same peer device both pick the same `claude_ui_pid` (e.g. PID recycling).
  **Mitigation**: existing `findLiveProxyCsid` already cuts off stale rows by `last_seen_at`; the `(device, pid)` match retains that liveness filter.
- **Risk**: the migration runs the first time a user upgrades, and a bug here corrupts identity → the only key the system trusts.
  **Mitigation**: the migration is additive and idempotent; tests cover both fresh-DB and pre-existing-rows paths.  Local DB backup is recommended in the upgrade note but not enforced.
- **Trade-off**: opening the daemon to LAN under a single shared token is a meaningful security widening.  We accept it because (a) the safety net forces token presence, (b) the README guidance is explicit, and (c) per-agent auth is a clear next-change candidate but would not block this work.
- **Trade-off**: `list_agents` widening to "caller's team across all devices" makes the list longer.  Callers who only want same-device peers must filter client-side.  Acceptable because the primary use of `list_agents` is humans-eyeballing, not automated routing (routing is by `send_message` directly).

## Migration Plan

1. Bump version in `package.json` (handled in archive / release flow, not in this change).
2. First start of the new daemon: the schema migration runs automatically and backfills `device` from the configured (or default) local label.  No manual step required.
3. Old loopback clients keep working: they call `register_agent` without `device`, daemon auto-fills the local label.
4. To enable cross-host: user passes `--host <lan-ip> --token <t>` (and optionally `--device <label>`); peer runs `cross-agent-teams-channel --daemon-url ... --token ...` (and optionally `--device <label>`).  No client-code changes required on the peer beyond the new channel-cli flags.
5. **Rollback**: revert to the prior daemon version.  The added columns are harmless to the prior version (the old code ignores them); the rebuilt index still contains `(team, name)` as a prefix, which the old code accidentally relies on only insofar as it expects uniqueness on that prefix.  If a user populated multiple devices and rolls back, uniqueness on the old prefix can break — call this out in the upgrade note.
