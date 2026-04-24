## ADDED Requirements

### Requirement: register_claude_self and register_agent claude-code reject channel_session_id that conflicts with ui_pid's live proxy csid

When `register_claude_self` OR `register_agent({client:'claude-code'})` is invoked with BOTH `ui_pid` AND `channel_session_id` supplied, the daemon SHALL perform a consistency check BEFORE any agent-row UPSERT or delivery binding:

1. Query `__channel_proxy__` rows where `claude_ui_pid = <caller ui_pid>` AND `last_seen_at > now() - 5 minutes`, ordered by `last_seen_at DESC` with `LIMIT 1`. The 5-minute window MUST be the same constant used by the existing `register_claude_self auto-binds channel_session_id via ui_pid match` requirement. The query MUST NOT filter by team — the proxy always registers into `team='default'` while Claude hosts typically register into a project-derived team, and `claude_ui_pid` alone uniquely identifies the caller's proxy.
2. If no matching row exists, the consistency check is a no-op — the call MUST proceed to the existing explicit-bind path (identical semantics to `bind_channel`). The absence of a matching proxy means there is no basis to reject.
3. If a matching row exists AND its persisted csid (parsed from `delivery_payload` as `channel_session_id`) equals the supplied `channel_session_id`, the call MUST proceed to the existing explicit-bind path — this is the consistent case and today's behavior is preserved.
4. If a matching row exists AND its persisted csid differs from the supplied `channel_session_id`, the tool MUST reject the call with `{error: 'channel_session_id_ui_pid_mismatch', detail: {ui_pid_matched_csid: <proxy's csid>, supplied_csid: <caller's csid>}}`. No agents row UPSERT, no delivery binding, and no SSE fanout attach/detach SHALL occur.

This check applies only when BOTH `ui_pid` AND `channel_session_id` are supplied. If only `channel_session_id` is supplied (no `ui_pid`), no check is possible and today's explicit-bind semantics are preserved. If only `ui_pid` is supplied, the existing auto-bind path runs unchanged.

Callers with `client != 'claude-code'` are not affected.

#### Scenario: register_claude_self rejects mismatched csid vs live proxy csid

- **GIVEN** a live `__channel_proxy__` row with `team='default'`, `claude_ui_pid=27341`, `delivery_payload='{\"channel_session_id\":\"csid-f256fc1a\"}'`, and `last_seen_at` less than 5 minutes ago
- **WHEN** a caller invokes `register_claude_self({name:'opus', team:'default', ui_pid:27341, channel_session_id:'csid-45818c22'})`
- **THEN** the response is `{error: 'channel_session_id_ui_pid_mismatch', detail: {ui_pid_matched_csid: 'csid-f256fc1a', supplied_csid: 'csid-45818c22'}}`
- **AND** no agents row is UPSERT'd for `(default, opus)`
- **AND** no SSE fanout sink is attached under any `agent_id`

#### Scenario: register_claude_self proceeds when supplied csid matches live proxy csid

- **GIVEN** a live `__channel_proxy__` row with `team='default'`, `claude_ui_pid=27341`, `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`, a live sink under `'csid-abc'`, and `last_seen_at` less than 5 minutes ago
- **WHEN** a caller invokes `register_claude_self({name:'opus', team:'default', ui_pid:27341, channel_session_id:'csid-abc'})`
- **THEN** the call succeeds
- **AND** the agents row for `(default, opus)` has `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`

#### Scenario: register_claude_self proceeds when no live proxy row matches ui_pid

- **GIVEN** no `__channel_proxy__` row exists with `claude_ui_pid=99999` in any team within the last 5 minutes
- **WHEN** a caller invokes `register_claude_self({name:'opus', team:'default', ui_pid:99999, channel_session_id:'csid-abc'})` AND `'csid-abc'` has a live sink attached
- **THEN** the call succeeds
- **AND** the agents row for `(default, opus)` has `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`

#### Scenario: register_agent client=claude-code rejects mismatched csid vs live proxy csid

- **GIVEN** a live `__channel_proxy__` row with `team='default'`, `claude_ui_pid=27341`, `delivery_payload='{\"channel_session_id\":\"csid-f256fc1a\"}'`, and `last_seen_at` less than 5 minutes ago
- **WHEN** a caller invokes `register_agent({client:'claude-code', name:'opus', model:'sonnet', team:'default', ui_pid:27341, channel_session_id:'csid-45818c22'})`
- **THEN** the response is `{error: 'channel_session_id_ui_pid_mismatch', detail: {ui_pid_matched_csid: 'csid-f256fc1a', supplied_csid: 'csid-45818c22'}}`
- **AND** no agents row is UPSERT'd for `(default, opus)`

#### Scenario: mismatch check ignores team: proxy row in team A rejects caller in team B when csid mismatches

- **GIVEN** a live `__channel_proxy__` row exists in `team='default'` with `claude_ui_pid=27341`, `delivery_payload='{\"channel_session_id\":\"csid-real\"}'`, and `last_seen_at` less than 5 minutes ago
- **WHEN** a caller invokes `register_claude_self({name:'opus', team:'alpha', ui_pid:27341, channel_session_id:'csid-wrong'})`
- **THEN** the response is `{error: 'channel_session_id_ui_pid_mismatch', detail: {ui_pid_matched_csid: 'csid-real', supplied_csid: 'csid-wrong'}}`
- **AND** no agents row is UPSERT'd for `(alpha, opus)` (the proxy's team `default` does NOT block the mismatch check)

#### Scenario: expired proxy row does not trigger mismatch rejection

- **GIVEN** a `__channel_proxy__` row exists with `team='default'`, `claude_ui_pid=27341`, `delivery_payload='{\"channel_session_id\":\"csid-old\"}'`, and `last_seen_at` more than 5 minutes ago
- **WHEN** a caller invokes `register_claude_self({name:'opus', team:'default', ui_pid:27341, channel_session_id:'csid-new'})`
- **THEN** the expired row is ignored (outside the 5-minute window)
- **AND** the call proceeds to the explicit-bind path without rejection

#### Scenario: mismatch check only fires when both ui_pid and channel_session_id are supplied

- **GIVEN** a live `__channel_proxy__` row with `claude_ui_pid=27341` and csid `'csid-abc'`
- **WHEN** a caller invokes `register_claude_self({name:'opus', ui_pid:27341})` (no `channel_session_id`)
- **THEN** the call succeeds via the existing auto-bind path
- **AND** the agents row has `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`
