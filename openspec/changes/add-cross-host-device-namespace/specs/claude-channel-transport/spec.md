## MODIFIED Requirements

### Requirement: Proxy registration triggers reactive rebind of matching hosts

When an `__channel_proxy__` row is UPSERTed via `register_agent` and carries both a non-null `claude_ui_pid` and a `delivery.kind='claude-channel'` payload, the daemon SHALL, in the same transaction that writes the proxy row, look up hosts in the proxy's team that share the same UI ancestor on the SAME DEVICE AND are either unbound or bound to a stale csid.  Concretely, after writing the proxy row with `device=D`, `claude_ui_pid=P`, and `delivery.channel_session_id=C_new`, the daemon SHALL execute:

```sql
UPDATE agents
SET delivery_kind='claude-channel',
    delivery_payload=json_object('channel_session_id', :C_new)
WHERE role != '__channel_proxy__'
  AND device = :D
  AND runtime_ui_pid = :P
  AND team = :proxy_team
  AND (
    delivery_kind = 'none'
    OR (delivery_kind = 'claude-channel'
        AND json_extract(delivery_payload, '$.channel_session_id') != :C_new)
  );
```

The added `device = :D` predicate disambiguates `runtime_ui_pid` collisions across hosts: PIDs are not unique across machines, and without this filter a proxy on device `host-a` could spuriously rebind a host on device `host-b` that happens to share a PID value. Hosts whose `runtime_ui_pid` was never persisted (e.g. callers that did not supply `ui_pid` on register) MUST NOT be rebinded — auto-bind requires an explicit ui_pid evidence trail.  Hosts bound to a different non-claude-channel delivery (`codex-appserver`, etc.) MUST NOT be touched.

This requirement covers two scenarios transparently:

1. **Host-first race**: host registered before the proxy was up; its row was left at `delivery.kind='none'`; proxy registration now backfills it.
2. **Proxy restart**: proxy restarted with a new csid; hosts previously bound to the old csid get rewritten to the new one.

#### Scenario: reactive rebind promotes host from 'none' to claude-channel on same device

- **GIVEN** agent `alice` is registered in team `default` with `device='host-a'`, `role='worker'`, `runtime_ui_pid=25424`, and `delivery_kind='none'`
- **AND** no `__channel_proxy__` row exists yet for `device='host-a'` AND `claude_ui_pid=25424`
- **WHEN** the channel proxy on `device='host-a'` calls `register_agent({agent_type:'custom', role:'__channel_proxy__', name:'channel-proxy-27245', team:'default', model:'proxy', claude_ui_pid:25424, delivery:{kind:'claude-channel', channel_session_id:'csid-new'}})`
- **THEN** the proxy row is written successfully with `device='host-a'`
- **AND** alice's `agents` row has `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-new\"}'`

#### Scenario: reactive rebind does NOT cross devices when PIDs collide

- **GIVEN** agent `alice` is registered with `device='host-a'`, team `default`, `runtime_ui_pid=25424`, `delivery_kind='none'`
- **AND** agent `bob` is registered with `device='host-b'`, team `default`, `runtime_ui_pid=25424` (same PID, different device), `delivery_kind='none'`
- **WHEN** a proxy on `device='host-a'` calls `register_agent({..., claude_ui_pid:25424, delivery:{kind:'claude-channel', channel_session_id:'csid-new'}})`
- **THEN** alice's row is rebound to `claude-channel` with `csid-new`
- **AND** bob's row on `device='host-b'` is unchanged (still `delivery_kind='none'`)

#### Scenario: reactive rebind rewrites stale csid on proxy restart

- **GIVEN** agent `alice` is registered in team `default` with `device='host-a'`, `runtime_ui_pid=25424`, and `delivery={kind:'claude-channel', channel_session_id:'csid-old'}`
- **AND** a previous `__channel_proxy__` row exists with `device='host-a'`, `claude_ui_pid=25424`, and `delivery.channel_session_id='csid-old'`
- **WHEN** the proxy (new process on same device and same parent UI) calls `register_agent({..., claude_ui_pid:25424, delivery:{kind:'claude-channel', channel_session_id:'csid-new'}})`
- **THEN** the proxy row is UPSERTed with the new csid
- **AND** alice's row has `delivery_payload='{\"channel_session_id\":\"csid-new\"}'`

#### Scenario: reactive rebind does not touch hosts without runtime_ui_pid

- **GIVEN** agent `bob` is registered in team `default` on `device='host-a'` with `runtime_ui_pid IS NULL` and `delivery_kind='none'`
- **WHEN** the proxy on `device='host-a'` calls `register_agent({..., claude_ui_pid:25424, delivery:{kind:'claude-channel', channel_session_id:'csid-new'}})`
- **THEN** bob's row is unchanged (still `delivery_kind='none'`)

#### Scenario: reactive rebind does not overwrite non-claude delivery

- **GIVEN** agent `carol` is registered in team `default` on `device='host-a'` with `runtime_ui_pid=25424` and `delivery_kind='codex-appserver'`
- **WHEN** the proxy on `device='host-a'` calls `register_agent({..., claude_ui_pid:25424, delivery:{kind:'claude-channel', channel_session_id:'csid-new'}})`
- **THEN** carol's row still has `delivery_kind='codex-appserver'` (not overwritten)

#### Scenario: reactive rebind is scoped to the proxy's team

- **GIVEN** agent `dave` is registered in team `alpha` on `device='host-a'` with `runtime_ui_pid=25424` and `delivery_kind='none'`
- **WHEN** the proxy on `device='host-a'` calls `register_agent({..., team:'default', claude_ui_pid:25424, delivery:{kind:'claude-channel', channel_session_id:'csid-new'}})`
- **THEN** dave's row in team `alpha` is unchanged (still `delivery_kind='none'`)
