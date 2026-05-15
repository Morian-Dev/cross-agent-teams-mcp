## 1. Daemon-side: device label resolution and CLI flags

- [x] 1.1 Add `resolveLocalDeviceLabel(explicit?: string)` helper in `src/daemon/` that returns a normalised label (lowercase, non-`[a-z0-9_-]` replaced with `-`, fallback to `local`, reject `:` or length > 64) and unit-test it directly
- [x] 1.2 Add `--host`, `--device` parsing in `src/cli.ts`, plumb host/device into `runDaemon`, and pass `host` through to `startServer({...})`
- [x] 1.3 Implement the non-loopback bind safety net in `src/cli.ts`: when the resolved host is not in `127.0.0.0/8`, `::1`, or `::ffff:127.x.x.x` AND no `--token`/`CROSS_AGENT_TEAMS_MCP_TOKEN` is present, print `token_required_for_non_loopback_bind` to stderr and `process.exit(1)`
- [x] 1.4 Surface the resolved local device label to the rest of the daemon: extend `ServerOpts` in `src/daemon/server.ts` with `localDevice: string` and store it on a daemon-context object accessible from the MCP layer

## 2. Storage: schema, migration, identity widening

- [x] 2.1 Extend `applySchema` (`src/storage/schema.ts`) so a fresh `agents` table has `device TEXT NOT NULL`, `remote_addr TEXT`, and the UNIQUE index `agents_identity_idx` covers `(device, team, name)` in that order
- [x] 2.2 Add an idempotent startup migration that: (a) `ALTER TABLE agents ADD COLUMN device TEXT` when missing; (b) `ALTER TABLE agents ADD COLUMN remote_addr TEXT` when missing; (c) verifies no existing row has `name` containing `:` (abort with a clear stderr error referencing the offending `(team, name)` if so); (d) `UPDATE agents SET device = :local_device WHERE device IS NULL`; (e) `DROP INDEX IF EXISTS agents_identity_idx; CREATE UNIQUE INDEX agents_identity_idx ON agents(device, team, name)` — all wrapped in a single transaction
- [x] 2.3 Update `AgentsRepo` (`src/storage/agents-repo.ts`) so `register`, `findByIdentity`, and `list` operate on the `(device, team, name)` tuple instead of `(team, name)`; preserve all other column behaviour
- [x] 2.4 Add a `device` column accessor on `AgentListRow` and ensure `list_agents` queries select it
- [x] 2.5 Update `auto-bind-channel.ts::findLiveProxyCsid` to filter on `(device, claude_ui_pid, last_seen_at)` instead of `(claude_ui_pid, last_seen_at)`
- [x] 2.6 Update the reactive-rebind UPDATE in proxy registration code to include `AND device = :proxy_device`

## 3. Transport: per-session origin tagging

- [x] 3.1 Add an `onRequest` Fastify hook in `src/daemon/server.ts` (after `makeAuthHook`) that classifies the request peer as `local` or `remote` and computes `remote_addr` (raw string for remote, null for local; treat `127.0.0.0/8`, `::1`, `::ffff:127.x.x.x` as local)
- [x] 3.2 Stash `{origin, remote_addr}` on the in-memory MCP session record keyed by `Mcp-Session-Id`; expose a `getSessionOrigin(connection_id)` helper to MCP tools
- [x] 3.3 Confirm via unit test that the tag is present on the session for every dispatched tool call and that NO tool response includes `origin` or `remote_addr` keys

## 4. register_agent: device input and origin-based guards

- [x] 4.1 Extend `RegisterInput` (`src/mcp/register-agent.ts`) with `device?: string`; extend the tool schema in `src/mcp/tools.ts` to accept the new optional field
- [x] 4.2 In `RegisterAgentService.register`, read the session's `{origin, remote_addr}` and resolve `effective_device`: local-no-device → fill local label; local-with-matching → accept; local-with-mismatch → `device_spoofing_from_loopback`; remote-missing → `device_required_from_remote`; remote-matching-local → `device_spoofing_local_label_from_remote`; remote with invalid label (`:` or len > 64) → `invalid_device_label`
- [x] 4.3 Reject `name` containing `:` with `invalid_name_label` (apply to all origins)
- [x] 4.4 On successful insert from a remote session, persist `remote_addr`; on local session leave NULL
- [x] 4.5 Extend `RegisterResult` union and `toText` mapping so the new errors round-trip through the MCP tool envelope

## 5. send_message: name:device parsing

- [x] 5.1 Add a parser `parseToAgentName(raw: string, callerDevice: string)` that splits on the first `:`; both halves non-empty or returns an `invalid_to_agent_name` marker
- [x] 5.2 Wire the parser into `src/mcp/send-message.ts` so `findByIdentity` receives `(device_part, resolved_to_team, name_part)`; return `invalid_to_agent_name` envelope when the parser fails
- [x] 5.3 Confirm `unknown_recipient` semantics: bare name on caller's device with no match, `name:device` on a specified device with no match, both produce the existing envelope shape

## 6. list_agents: device field + cross-device scope

- [x] 6.1 Extend `PublicAgentListRow` (`src/mcp/agent-public-row.ts`) with a `device: string` field; update `toPublicAgentRow` to read it from `AgentListRow`
- [x] 6.2 Update `AgentsRepo.list` to drop any implicit device filter so listing within a team returns every device's rows (keeps the existing `excludeRoles` filter)
- [x] 6.3 Verify via test that `list_agents` does NOT return `origin` or `remote_addr`

## 7. broadcast / broadcast_to_role: cross-device, same-team

- [x] 7.1 Verify (or adjust) the recipient query in `src/mcp/broadcast.ts` to enumerate caller's team across all devices, excluding sender and `__channel_proxy__`
- [x] 7.2 Same review for `src/mcp/broadcast-to-role.ts`; ensure no implicit device filter remains
- [x] 7.3 Reject any `to_device` parameter at the Zod schema layer (defensive — the design forbids it)
- [x] 7.4 Update the tool descriptions in `src/mcp/tools.ts` so `broadcast_to_role` mentions same-team across all devices

## 8. channel-cli plugin: --token and --device

- [x] 8.1 Extend `parseCliArgs` in `plugins/cross-agent-teams-channel/src/cli.ts` to accept `--token` (with `CROSS_AGENT_TEAMS_MCP_TOKEN` env fallback) and `--device` (with hostname-derived default identical to the daemon's normaliser)
- [x] 8.2 In `plugins/cross-agent-teams-channel/src/daemon-client.ts::runRegistrationSequence`, thread the token into the `StreamableHTTPClientTransport` constructor as `requestInit.headers.Authorization = 'Bearer <token>'` when present
- [x] 8.3 Thread the resolved `device` into the proxy's `register_agent` call arguments
- [x] 8.4 Reject `--device has:colon` / oversized device labels with `invalid_device_label` and non-zero exit
- [x] 8.5 Document the new flags in `--help`/CLI usage banner if one exists; otherwise update the README CLI section

## 9. Tests

- [x] 9.1 Unit: `resolveLocalDeviceLabel` (hostname normalisation, fallback, `:` rejection, length cap)
- [x] 9.2 Unit: CLI parses `--host`, `--device`, `--token`; non-loopback without token exits 1 with the right stderr
- [x] 9.3 Unit: schema migration on a synthetic legacy DB adds `device`/`remote_addr`, backfills, rebuilds the index; idempotent on repeat
- [x] 9.4 Unit: schema migration aborts when an existing `name` contains `:`
- [x] 9.5 Unit: `parseToAgentName` covers bare, with-colon, empty-half, and very long names
- [x] 9.6 Unit: origin classification correctly tags `127.0.0.1`, `::1`, `::ffff:127.0.0.1`, and a LAN address
- [x] 9.7 Integration: loopback register without device fills local label; loopback register with matching device accepted; loopback register with mismatched device returns `device_spoofing_from_loopback`
- [x] 9.8 Integration: remote register without device returns `device_required_from_remote`; with local-label returns `device_spoofing_local_label_from_remote`; with valid device succeeds and persists `remote_addr`
- [x] 9.9 Integration: register two agents with identical `(team, name)` on distinct `device` values — both rows persist
- [x] 9.10 Integration: `list_agents` returns both rows above with their `device` fields and no `origin`/`remote_addr`
- [x] 9.11 Integration: `send_message({to_agent_name:'creator'})` resolves to caller's device; `send_message({to_agent_name:'creator:host-b'})` resolves to `(host-b, ..., creator)`; invalid `:host-b` / `bob:` returns `invalid_to_agent_name`
- [x] 9.12 Integration: `broadcast` reaches a recipient on a different device in the same team
- [x] 9.13 Integration: channel-proxy auto-bind for a `(device='host-b', ui_pid=N)` caller does NOT match a `(device='host-a', claude_ui_pid=N)` proxy row
- [x] 9.14 Integration: channel-cli with `--token` + `--device` registers a proxy whose row carries the supplied device
- [x] 9.15 Update / re-run existing tests that asserted on `(team, name)` uniqueness or absence of `device` in responses; adjust to the new shape

## 10. Documentation

- [x] 10.1 Add a "Cross-host (LAN) collaboration" section to `README.md` and `README.zh-CN.md` covering: daemon `--host` + `--token` + `--device`, peer command `cross-agent-teams-channel --daemon-url ... --token ... --device ...`, the `name:device` addressing rule, and the security caveats (LAN exposure, single shared token)
- [x] 10.2 Add a brief upgrade note documenting that the storage migration auto-runs on first startup of the new version and that rolling back after registering multi-device data may violate the old `(team, name)` uniqueness assumption
