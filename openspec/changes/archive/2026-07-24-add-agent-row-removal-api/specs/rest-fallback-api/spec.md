## MODIFIED Requirements

### Requirement: Loopback-only REST lifeboat surface

The daemon SHALL expose four REST endpoints on its existing HTTP port under the `/api/` prefix, as a fallback for agents whose MCP client transport is unavailable and for local operator maintenance:

- `POST /api/send`
- `GET /api/inbox`
- `GET /api/agents`
- `DELETE /api/agents/:agent_id`

These endpoints MUST be reachable ONLY from a loopback origin. Any request whose classified origin is `remote` (non-loopback peer address, per the daemon's existing `classifyPeerAddress` / `req.xatsPeer` classification) MUST be rejected with HTTP 403 and MUST NOT perform any data-layer action. Remote callers have no REST API by design.

The endpoints are additive: they MUST NOT alter the behavior, framing, or availability of `POST/GET/DELETE /mcp` or `GET /health`.

#### Scenario: Loopback request reaches the REST API

- **GIVEN** the daemon is running and a caller connects from `127.0.0.1`
- **WHEN** the caller issues `GET /api/agents?team=default`
- **THEN** the request is served (not 403) and returns the team's agents

#### Scenario: Remote request is refused

- **GIVEN** the daemon is bound so a non-loopback peer can connect (e.g. `0.0.0.0:9100`)
- **WHEN** a caller from `10.0.0.42` issues any `/api/*` request
- **THEN** the response status is 403
- **AND** no message is inserted, no cursor is advanced, and no agent state changes

#### Scenario: Remote caller cannot remove an agent row

- **GIVEN** the daemon is bound so a non-loopback peer can connect
- **AND** an agent row exists with `agent_id` `A`
- **WHEN** a caller from a remote address issues `DELETE /api/agents/A` with a valid bearer token
- **THEN** the response status is 403
- **AND** the row for `A` still exists

#### Scenario: MCP and health endpoints are unaffected

- **WHEN** the REST endpoints are mounted
- **THEN** `POST /mcp`, `GET /mcp`, `DELETE /mcp`, and `GET /health` behave exactly as before

## ADDED Requirements

### Requirement: DELETE /api/agents/:agent_id removes a single registry row

The daemon SHALL expose `DELETE /api/agents/:agent_id`, which removes exactly the `agents` row whose `agent_id` equals the path parameter.

The target SHALL be addressed by `agent_id` only. The endpoint MUST NOT resolve its target through `(localDevice, team, name)` the way `POST /api/send` and `GET /api/inbox` resolve theirs, because rows carrying a device label other than the daemon's `localDevice` are legitimate removal targets and would be unreachable under that resolution.

On success the response status SHALL be 200 with body `{ deleted: true, agent_id, team, name }`, echoing the identity of the row that was removed.

When no row matches the given `agent_id`, the response status SHALL be 404 with body `{ error: 'unknown_agent' }` — the same error string `unregister_self` returns for the same condition. The endpoint MUST NOT report success for a target that did not exist.

Removal SHALL be performed through the same transactional helper used by `unregister_self`, so that both entry points share one removal code path.

The endpoint MUST NOT gate removal on whether the target appears live. In particular it MUST NOT consult the `online` flag: that flag is derived from `isAgentLive`, which for runtimes registering without `runtime_ui_pid` and without `tmux_pane_id` (kimi-code) falls through to a multi-day `last_seen_at` window and therefore reads `true` long after the agent is gone.

#### Scenario: Removing an existing row

- **GIVEN** an agent `alice` in team `default` is registered with `agent_id` `A`
- **WHEN** a loopback caller issues `DELETE /api/agents/A`
- **THEN** the response status is 200 with `{ deleted: true, agent_id: "A", team: "default", name: "alice" }`
- **AND** `GET /api/agents?team=default` no longer lists `alice`

#### Scenario: Removing an unknown id reports 404

- **GIVEN** no agent row has `agent_id` `does-not-exist`
- **WHEN** a loopback caller issues `DELETE /api/agents/does-not-exist`
- **THEN** the response status is 404 with `{ error: 'unknown_agent' }`

#### Scenario: Repeating a removal reports 404

- **GIVEN** a loopback caller has already removed `agent_id` `A` successfully
- **WHEN** the same caller issues `DELETE /api/agents/A` again
- **THEN** the response status is 404 with `{ error: 'unknown_agent' }`

#### Scenario: A row on a foreign device label can be removed

- **GIVEN** the daemon's `localDevice` is `jt`
- **AND** an agent row exists in team `default` with device `other-host` and `agent_id` `B`
- **WHEN** a loopback caller issues `DELETE /api/agents/B`
- **THEN** the response status is 200 and the row is removed

#### Scenario: An apparently-online row can be removed

- **GIVEN** an agent row whose computed `online` flag is `true`
- **WHEN** a loopback caller issues `DELETE /api/agents/` for that row's id
- **THEN** the removal succeeds and is not refused on liveness grounds
