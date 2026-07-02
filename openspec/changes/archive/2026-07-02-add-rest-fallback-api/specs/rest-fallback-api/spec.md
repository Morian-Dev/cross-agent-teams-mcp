## ADDED Requirements

### Requirement: Loopback-only REST lifeboat surface

The daemon SHALL expose three REST endpoints on its existing HTTP port under the `/api/` prefix, as a fallback for agents whose MCP client transport is unavailable:

- `POST /api/send`
- `GET /api/inbox`
- `GET /api/agents`

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

#### Scenario: MCP and health endpoints are unaffected

- **WHEN** the REST endpoints are mounted
- **THEN** `POST /mcp`, `GET /mcp`, `DELETE /mcp`, and `GET /health` behave exactly as before

### Requirement: REST calls have zero session and delivery side-effects

A `/api/*` call MUST NOT create, mutate, close, or take over any in-memory MCP session; MUST NOT change any `(device, team, name) → connection_id` binding held by `RegisterAgentService`; and MUST NOT attach, detach, or rebind any delivery sink (SSE fanout, channel-wake fanout, or tmux pane binding). It operates purely at the data layer (the `agents`, `messages`, and events tables) on behalf of an ALREADY-REGISTERED `agent_id`.

Consequently, a REST call is safe regardless of whether the named agent currently has a live MCP session: it never disturbs a live session and never performs the cross-session `register_agent` takeover that raw MCP-over-`curl` would.

The REST surface MUST NOT expose `register_agent` or any registration/identity-binding operation. An agent that has never registered has no `agent_id` and therefore cannot be named as a sender or inbox owner.

#### Scenario: Sending via REST does not disturb the sender's live MCP session

- **GIVEN** agent `alice` in team `default` has a live MCP session `S1` with an attached delivery binding
- **WHEN** a loopback caller issues `POST /api/send` with `from = { team: "default", name: "alice" }`
- **THEN** the message is sent as `alice`
- **AND** session `S1` is still present in the daemon's `sessions` map with its delivery binding intact (no takeover, no force-close)

#### Scenario: REST send while the agent's MCP session is dead

- **GIVEN** agent `alice`'s MCP session has already been closed, but her `agents` row still exists
- **WHEN** a loopback caller issues `POST /api/send` with `from = { team: "default", name: "alice" }`
- **THEN** the message is sent as `alice` (resolved from the persisted `agents` row)
- **AND** no MCP session is created for `alice`

### Requirement: POST /api/send sends as an existing agent, reusing the MCP send path

`POST /api/send` SHALL accept a JSON body `{ from: { team, name }, to: { team, name } | { agent_id }, subject?, body, need_reply?, auto_poke? }`.

The daemon MUST resolve `from` by looking up the registered agent whose `(team, name)` matches on the local device. If no such registered agent exists, the daemon MUST reject the request (e.g. `unknown_sender`) and MUST NOT insert a message. It MUST then run the SAME message-send logic used by the `send_message` MCP tool (`SendMessageService`): resolve the recipient by `(to.team, to.name)` or `to.agent_id`, insert the message and its event, and — unless `auto_poke` is `false` — fan out the delivery poke to the recipient exactly as the MCP tool does. The response body MUST be the same JSON result shape the `send_message` tool returns (message id, event id, recipients, poke outcome).

`need_reply` and `auto_poke` MUST default to the same values as the MCP tool (`need_reply` defaults true, `auto_poke` defaults true).

#### Scenario: Send to a recipient by team and name

- **GIVEN** registered agents `alice(default)` and `bob(default)` exist, and `bob` has a deliverable transport
- **WHEN** a loopback caller `POST /api/send` with `{ from: {team:"default",name:"alice"}, to: {team:"default",name:"bob"}, body:"hi" }`
- **THEN** a message row from `alice`'s agent_id to `bob`'s agent_id is inserted
- **AND** `bob` is poked via his delivery transport
- **AND** the response contains the message id, event id, and recipients, matching the `send_message` tool result shape

#### Scenario: Unknown sender is rejected with no insert

- **WHEN** a loopback caller `POST /api/send` with `from = { team:"default", name:"ghost" }` where no registered agent `ghost(default)` exists
- **THEN** the request is rejected (e.g. `unknown_sender`)
- **AND** no message row is inserted

#### Scenario: Unknown recipient returns the same error as the tool

- **WHEN** a loopback caller `POST /api/send` targets a `(team, name)` that is not a registered agent
- **THEN** the response reports `unknown_recipient` (the same outcome the `send_message` tool produces) with no side effects

#### Scenario: auto_poke false inserts without poking

- **WHEN** a loopback caller `POST /api/send` with `auto_poke: false`
- **THEN** the message is inserted and the recipient is NOT poked
- **AND** the response reflects `poked: false`, matching the tool behavior

### Requirement: GET /api/inbox reads an agent's inbox, reusing the MCP inbox path

`GET /api/inbox` SHALL accept query parameters `team`, `name`, and optional `since_event_id`. The daemon MUST resolve the caller agent by `(team, name)` on the local device; if none exists it MUST reject the request. It MUST then read the inbox using the SAME logic as the `get_inbox` MCP tool (`GetInboxService`):

- When `since_event_id` is OMITTED, the read MUST advance the agent's stored `last_processed_event_id` cursor (a real read), matching the MCP default.
- When `since_event_id` is SUPPLIED (any integer, including 0), the read MUST be read-only inspection and MUST NOT advance the stored cursor.

The response body MUST be the same JSON shape the `get_inbox` tool returns (`messages`, `has_more`, `last_event_id`).

#### Scenario: Default read advances the cursor

- **GIVEN** agent `alice(default)` has unread messages and stored cursor `C`
- **WHEN** a loopback caller `GET /api/inbox?team=default&name=alice` (no `since_event_id`)
- **THEN** the unread messages past `C` are returned
- **AND** `alice`'s stored `last_processed_event_id` is advanced to the highest returned event id

#### Scenario: Explicit since_event_id is read-only

- **GIVEN** agent `alice(default)` has stored cursor `C`
- **WHEN** a loopback caller `GET /api/inbox?team=default&name=alice&since_event_id=0`
- **THEN** messages after event id 0 are returned for inspection
- **AND** `alice`'s stored `last_processed_event_id` is unchanged

#### Scenario: Unknown inbox owner is rejected

- **WHEN** a loopback caller `GET /api/inbox?team=default&name=ghost` where no such registered agent exists
- **THEN** the request is rejected and no cursor is created or advanced

### Requirement: GET /api/agents lists a team's agents

`GET /api/agents` SHALL accept a `team` query parameter and return the agents in that team, using the same data the `list_agents` MCP tool returns (team-scoped). It MUST NOT return cross-team agents.

#### Scenario: List a team's agents

- **GIVEN** team `default` has registered agents `alice` and `bob`, and team `other` has `carol`
- **WHEN** a loopback caller `GET /api/agents?team=default`
- **THEN** the response lists `alice` and `bob`
- **AND** does NOT include `carol`

### Requirement: REST auth and error responses

Every `/api/*` request MUST satisfy the same token authentication as `/mcp`: when the daemon was started with `--token`, a request missing or mismatching the token (via `Authorization: Bearer <token>` or `token=<token>` query) MUST be rejected with HTTP 401. When no token is configured, requests are accepted (subject still to the loopback gate).

REST error responses (401 auth, 403 remote, 4xx validation, `unknown_sender` / `unknown_recipient`) SHALL use a plain JSON body describing the error. Because the consumers are HTTP/`curl` clients rather than a strict JSON-RPC deserializer, a plain `{ "error": <code> }` body is acceptable here (this surface is not subject to the MCP JSON-RPC transport-poisoning constraint that governs `/mcp`).

#### Scenario: Missing token is rejected when a token is configured

- **GIVEN** the daemon was started with `--token s3cret`
- **WHEN** a loopback caller issues `POST /api/send` without the token
- **THEN** the response status is 401

#### Scenario: Loopback gate is checked independently of the token

- **GIVEN** the daemon was started with `--token s3cret`
- **WHEN** a remote caller presents the correct token to `/api/send`
- **THEN** the response status is 403 (loopback gate), because remote callers have no REST API regardless of token

### Requirement: Loopback-trust identity is an accepted tradeoff

Because `/api/*` resolves the sender by asserted `(team, name)` rather than a session-bound proven identity, the REST surface MUST remain restricted to loopback origin AND MUST NOT expose `register_agent` or any other identity-binding / session-mutating operation — these two constraints together bound the blast radius. Under them, any local process that can reach the loopback interface (and present the token, if configured) can act as ANY local agent with no takeover and no visible signal; this is an ACCEPTED tradeoff, consistent with the project's existing local-trust model (local agents already mutually trust one another and a local process can already impersonate in-band).

#### Scenario: Any local process may act as any local agent

- **GIVEN** the token (if any) is presented and the request is from loopback
- **WHEN** a local process `POST /api/send` naming `from = { team, name }` of an agent it does not "own"
- **THEN** the message is sent as that agent (accepted under the local-trust model), with no takeover of that agent's session

### Requirement: Inbox cursor-advance CSRF exposure is a bounded accepted risk

Because `GET /api/inbox` advances the reader's cursor by default and "loopback" includes a browser on the same machine, a cross-site web page could cause the browser to issue a state-changing `GET /api/inbox` (a CSRF). When the daemon runs with `--token`, the token gate blocks this entirely (the cross-site request lacks the token → 401 before any cursor advance). When no token is configured, this exposure is ACCEPTED as bounded: the attacker cannot read the response (CORS) and cannot send or impersonate; the only effect is that the named agent's cursor advances, so it may miss unread messages. The daemon MUST therefore keep the loopback + token gate as the mitigation and MUST NOT expose any data-reading or state-mutating REST operation whose cross-site abuse would exceed this bound. Deployments that cannot accept even the missed-message effect MUST run the daemon with `--token`.

#### Scenario: Token blocks the cross-site cursor advance

- **GIVEN** the daemon was started with `--token`
- **WHEN** a request to `GET /api/inbox` arrives without the token
- **THEN** it is rejected with 401 and the agent's `last_processed_event_id` is NOT advanced
