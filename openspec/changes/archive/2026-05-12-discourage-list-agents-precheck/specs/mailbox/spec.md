## ADDED Requirements

### Requirement: send_message tool description forbids pre-verifying the recipient via list_agents

The `send_message` MCP tool description (the by-name variant; see `src/mcp/tools.ts` `SEND_MESSAGE_DESC`) SHALL explicitly direct callers not to pre-verify the recipient's existence via `list_agents` before issuing the send. The description's prose may be reworded, but it MUST contain all of:

1. A directive forbidding pre-verification (e.g., the substring `DO NOT` paired with `list_agents` and the notion of pre-verification, or equivalent jussive prose).
2. A statement that miss is signalled cleanly by the `unknown_recipient` return value, so callers understand the recovery path is "try send, then handle the error" rather than "verify, then send".
3. A note that this rule applies to both same-team and cross-team sends — same-team pre-verification is wasted work, cross-team pre-verification via `list_agents` is structurally impossible because `list_agents` is caller-team scoped.

The directive language SHALL use jussive form (DO NOT / MUST NOT) rather than advisory hedges, for the same reason as the `list_agents` description requirement.

This Requirement applies to `send_message` only. `send_message_by_id`, `broadcast`, and `broadcast_to_role` are out of scope for this change.

#### Scenario: send_message description forbids list_agents pre-verification

- **GIVEN** the MCP server has registered the `send_message` tool
- **WHEN** the registered tool's description string is inspected
- **THEN** the description contains the literal substring `list_agents`
- **AND** the description contains directive prose forbidding pre-verification (case-insensitive match on `DO NOT` together with `pre` within the same sentence as `list_agents`, or an equivalent MUST NOT formulation)

#### Scenario: send_message description references unknown_recipient as the miss signal

- **GIVEN** the MCP server has registered the `send_message` tool
- **WHEN** the registered tool's description string is inspected
- **THEN** the description contains the literal substring `unknown_recipient`

#### Scenario: send_message description covers both same-team and cross-team pre-check rule

- **GIVEN** the MCP server has registered the `send_message` tool
- **WHEN** the registered tool's description string is inspected
- **THEN** the description's prose makes clear that the no-pre-verification rule applies to both same-team and cross-team sends (e.g., by naming both cases explicitly, or by stating the rule in unqualified universal terms)
