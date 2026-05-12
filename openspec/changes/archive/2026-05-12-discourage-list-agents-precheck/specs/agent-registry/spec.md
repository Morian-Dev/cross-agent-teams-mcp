## ADDED Requirements

### Requirement: list_agents tool description forbids pre-flight verification before send_message

The `list_agents` MCP tool description SHALL explicitly state that the tool is scoped to the caller's team and that it MUST NOT be used to verify a recipient's existence before calling `send_message`. The description's prose may be reworded, but it MUST contain all of:

1. A statement that `list_agents` returns only agents in the caller's team (e.g., the substring `caller`'s team or `caller-team only`).
2. A statement that `list_agents` cannot see agents in other teams (e.g., the substring `CANNOT` paired with `cross-team`, or equivalent jussive prose).
3. A directive forbidding pre-flight verification before `send_message` (e.g., the substring `DO NOT` paired with `send_message` and the notion of pre-verification, or equivalent jussive prose).
4. A pointer to the canonical miss signal — `unknown_recipient` returned by `send_message` — so the caller understands the recommended recovery path.

The directive language SHALL use jussive form (DO NOT / CANNOT / MUST NOT) rather than advisory hedges (you may / consider / it is recommended), because the observed failure mode is the LLM overriding implicit norms with defensive RLHF behavior.

#### Scenario: list_agents description declares caller-team scope

- **GIVEN** the MCP server has registered the `list_agents` tool
- **WHEN** the registered tool's description string is inspected
- **THEN** the description contains a statement that the tool returns agents in the caller's team only (case-insensitive match on `caller`'s team or `caller-team only`)

#### Scenario: list_agents description forbids cross-team verification use

- **GIVEN** the MCP server has registered the `list_agents` tool
- **WHEN** the registered tool's description string is inspected
- **THEN** the description contains jussive prose stating that `list_agents` cannot see cross-team agents (case-insensitive match on `CANNOT` together with `cross-team` within the same sentence, or an equivalent MUST NOT formulation)

#### Scenario: list_agents description forbids pre-flight verification before send_message

- **GIVEN** the MCP server has registered the `list_agents` tool
- **WHEN** the registered tool's description string is inspected
- **THEN** the description contains the literal substring `send_message`
- **AND** the description contains directive prose forbidding using `list_agents` as a pre-flight check (case-insensitive match on `DO NOT` together with `pre` (as in pre-flight, pre-verify, or pre-check) within the same sentence)
- **AND** the description references `unknown_recipient` as the canonical miss signal returned by `send_message`
