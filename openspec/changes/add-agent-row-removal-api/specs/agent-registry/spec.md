## ADDED Requirements

### Requirement: Registry row removal is not agent termination

Removing an `agents` row — whether via `unregister_self` or via `DELETE /api/agents/:agent_id` — SHALL be understood as deleting the daemon's registration record for an agent, and NOTHING else. It MUST NOT be documented, described, or relied upon as a way to stop, kill, or shut down the agent behind that row.

Removal SHALL NOT touch the process, tmux pane, MCP session, or runtime-side session that the row described. The daemon has no mechanism to terminate any of those, and MUST NOT claim otherwise.

Two consequences SHALL be stated wherever removal is documented:

1. A running agent whose row is removed will fail its next xats tool call with the daemon's unregistered-session rejection, and must call `register_agent` again to become addressable. This is expected behaviour of an operator action, not a fault.
2. For runtimes whose identity is a server-side session rather than a local process — `kimi-code`, whose delivery is `{ kind: 'kimi-server', session_id, base_url }` — the underlying session continues to exist and continues to accept prompts after the row is removed. Removal ends the agent's addressability through xats; it does not end the session.

Historical `messages` and `events` rows MAY continue to reference a removed `agent_id` as stored text. Removal MUST NOT rewrite historical rows.

#### Scenario: Removed row does not stop the underlying runtime

- **GIVEN** a registered `kimi-code` agent whose delivery carries `session_id` `S` on a reachable kimi server
- **WHEN** an operator removes that agent's row via `DELETE /api/agents/:agent_id`
- **THEN** the row is gone and the agent is no longer addressable through xats
- **AND** session `S` still exists on the kimi server and still accepts prompts

#### Scenario: A live agent whose row was removed must re-register

- **GIVEN** an agent with a live MCP session whose row has been removed by an operator
- **WHEN** that agent invokes any business tool
- **THEN** the call is rejected as an unregistered session
- **AND** the agent can recover by calling `register_agent` again

#### Scenario: Historical mail survives removal

- **GIVEN** an agent `A` that has sent messages, and whose row is then removed
- **WHEN** any agent reads mailbox history referencing `A`
- **THEN** the stored `from_agent_id` / sender text for those messages is unchanged
