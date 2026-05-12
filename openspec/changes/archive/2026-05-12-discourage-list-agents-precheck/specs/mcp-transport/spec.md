## ADDED Requirements

### Requirement: MCP server instructions field includes anti-pattern paragraph forbidding list_agents pre-check before send_message

The daemon's `McpServer` `instructions` field (declared via `ServerOptions.instructions`, exposed in every session's `initialize` response per the existing "MCP server initialize returns instructions field" requirement) SHALL contain a server-level anti-pattern paragraph that reinforces the per-tool description rules introduced for `list_agents` and `send_message`. The prose may be reworded, but the `instructions` string MUST contain all of:

1. The literal substring `list_agents`.
2. The literal substring `send_message`.
3. The literal substring `unknown_recipient`.
4. A directive forbidding using `list_agents` to pre-verify a recipient before `send_message` (case-insensitive match on `DO NOT` / `MUST NOT` together with `pre` within the same sentence as `list_agents`).
5. A statement that `list_agents` is caller-team scoped and cannot see cross-team agents (case-insensitive match on `caller`'s team or `caller-team` together with prose declaring inability to see other teams).

The directive SHALL appear as part of the existing single `instructions` string — no new instructions slot is introduced. The paragraph SHALL coexist with the previously specified content (xats abbreviation, project_dir team default) without removing or contradicting it.

#### Scenario: instructions string contains the anti-pattern paragraph

- **GIVEN** an MCP client opens a session and receives the `initialize` response
- **WHEN** the response's `instructions` field is inspected
- **THEN** the string contains the literal substring `list_agents`
- **AND** the string contains the literal substring `send_message`
- **AND** the string contains the literal substring `unknown_recipient`

#### Scenario: instructions string uses jussive prose for the pre-check ban

- **GIVEN** an MCP client opens a session and receives the `initialize` response
- **WHEN** the response's `instructions` field is inspected
- **THEN** the string contains directive prose forbidding pre-verification (case-insensitive match on `DO NOT` or `MUST NOT` together with `pre` within the same sentence as `list_agents`)

#### Scenario: instructions string declares list_agents caller-team scope at server level

- **GIVEN** an MCP client opens a session and receives the `initialize` response
- **WHEN** the response's `instructions` field is inspected
- **THEN** the string declares that `list_agents` is scoped to the caller's team and cannot see cross-team agents (case-insensitive match on `caller`'s team or `caller-team`, together with prose stating inability to see other teams)

#### Scenario: instructions string preserves existing required content

- **GIVEN** an MCP client opens a session and receives the `initialize` response
- **WHEN** the response's `instructions` field is inspected
- **THEN** the string still contains the literal substring `xats`
- **AND** the string still contains the literal substring `cross-agent-teams`
- **AND** the string still contains the literal substring `project_dir`
