## 1. Schema & migration

- [x] 1.1 Add `claude_ui_pid INTEGER` column to the fresh-database `agents` schema in `src/agents/schema.ts` (or equivalent)
- [x] 1.2 Add idempotent startup migration: `ALTER TABLE agents ADD COLUMN claude_ui_pid INTEGER` when column is missing
- [x] 1.3 Add `runtime_ui_pid` persistence when register_claude_self / register_agent(client=claude-code) receives `ui_pid` but tmux binding does not converge (ensure the column is written even in the "no tmux match" branch)

## 2. register_agent schema extension

- [x] 2.1 Extend `register_agent` Zod schema to accept optional `claude_ui_pid: z.number().int().positive()`
- [x] 2.2 Add validation: reject `claude_ui_pid` unless `role === '__channel_proxy__'`
- [x] 2.3 In UPSERT logic, write `claude_ui_pid` on insert and overwrite on re-registration when supplied; preserve existing value when omitted

## 3. Proxy plugin — pass claude_ui_pid and delivery

- [x] 3.1 Update `plugins/cross-agent-teams-channel/src/daemon-client.ts` `runRegistrationSequence` to include `claude_ui_pid: process.ppid` and `delivery: {kind: 'claude-channel', channel_session_id: config.channel_session_id}` on its `register_agent` call
- [x] 3.2 Update the proxy's unit tests to assert both fields are present on the outbound `register_agent` payload

## 4. Host-side auto-bind on register

- [x] 4.1 In the shared internal handler for `register_claude_self` / `register_agent({client:'claude-code'})`, after identity UPSERT and runtime binding, add an auto-bind branch: only run when `ui_pid` was supplied AND no explicit `channel_session_id` was provided
- [x] 4.2 Implement proxy lookup SQL: `SELECT delivery_payload FROM agents WHERE role='__channel_proxy__' AND claude_ui_pid=:ui_pid AND team=:team AND last_seen_at > datetime('now','-5 minutes') ORDER BY last_seen_at DESC LIMIT 1`
- [x] 4.3 Extract csid from `delivery_payload` JSON and check `ChannelWakeFanout.has(csid)` before writing
- [x] 4.4 When sink is live, write caller's `delivery_kind='claude-channel'` + `delivery_payload=json_object('channel_session_id', <csid>)` and include `channel_session_id: <csid>` in the success response envelope
- [x] 4.5 When sink is dead or no proxy row found, leave caller delivery unchanged and do NOT surface an error

## 5. Proxy-side reactive rebind

- [x] 5.1 In the `register_agent` handler, after a `__channel_proxy__` UPSERT that writes a `claude_ui_pid` AND `delivery.kind='claude-channel'`, run the rebind SQL:
      ```
      UPDATE agents
      SET delivery_kind='claude-channel',
          delivery_payload=json_object('channel_session_id', :new_csid)
      WHERE role != '__channel_proxy__'
        AND runtime_ui_pid = :claude_ui_pid
        AND team = :proxy_team
        AND (delivery_kind='none'
             OR (delivery_kind='claude-channel'
                 AND json_extract(delivery_payload,'$.channel_session_id') != :new_csid))
      ```
- [x] 5.2 Run the rebind inside the same transaction as the proxy UPSERT
- [x] 5.3 Ensure the rebind excludes `codex-appserver` and any future non-claude-channel delivery kinds

## 6. Tests

- [ ] 6.1 Unit test: `register_agent` schema rejects `claude_ui_pid` when `role!='__channel_proxy__'`
- [ ] 6.2 Unit test: `register_agent` schema rejects non-positive / non-integer `claude_ui_pid`
- [ ] 6.3 Unit test: `register_agent` with `role='__channel_proxy__'` + `claude_ui_pid` persists the column
- [ ] 6.4 Unit test: proxy lookup returns most recent live row when multiple exist for the same `claude_ui_pid`
- [ ] 6.5 Unit test: `register_claude_self({ui_pid})` with live proxy row → writes `delivery.kind='claude-channel'` with the proxy's csid
- [ ] 6.6 Unit test: `register_claude_self({ui_pid})` with no matching proxy row → delivery stays `'none'`
- [ ] 6.7 Unit test: `register_claude_self({ui_pid})` with matching proxy row but dead `ChannelWakeFanout` sink → delivery stays `'none'`
- [ ] 6.8 Unit test: `register_claude_self` without `ui_pid` → auto-bind does not run
- [ ] 6.9 Unit test: `register_claude_self({ui_pid, channel_session_id})` (explicit) → explicit path runs, auto-bind does not
- [ ] 6.10 Unit test: reactive rebind promotes a pre-existing `delivery='none'` host to `claude-channel` when proxy registers
- [ ] 6.11 Unit test: reactive rebind rewrites stale csid when proxy restarts with a new csid
- [ ] 6.12 Unit test: reactive rebind skips hosts with `runtime_ui_pid IS NULL`
- [ ] 6.13 Unit test: reactive rebind does not overwrite `codex-appserver` delivery
- [ ] 6.14 Unit test: reactive rebind is scoped to the proxy's team (hosts in other teams unchanged)
- [ ] 6.15 Unit test: startup migration adds `claude_ui_pid` column to legacy schema idempotently
- [ ] 6.16 Integration test: end-to-end — host registers first, then proxy starts; after proxy registers, `list_agents` shows host's `delivery.kind='claude-channel'` with proxy's csid
- [ ] 6.17 Integration test: end-to-end — proxy restart with new csid automatically rebinds all bound hosts

## 7. Docs

- [ ] 7.1 Update `docs/configs/claude-code.md` to explain auto-bind: `ui_pid` is now sufficient for channel delivery; explicit csid is optional
- [ ] 7.2 Update `plugins/cross-agent-teams-channel/README.md` to mention that `register_claude_self({ui_pid})` is the preferred flow and the startup hint notification is now backward-compat only
- [ ] 7.3 Update the `register_claude_self` tool description in `src/mcp/tools.ts` to mention auto-bind behavior tied to `ui_pid`
