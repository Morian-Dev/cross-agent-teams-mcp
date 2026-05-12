## Why

Agents calling `send_message` exhibit a wasteful and broken pre-check pattern: when the user has already specified the recipient's `to_team` and/or `to_agent_name`, the agent still calls `list_agents` first to "verify" the target exists. This is doubly wrong: (1) `list_agents` is scoped to the caller's team, so cross-team targets always appear missing — the agent then incorrectly concludes the send would fail and aborts; (2) even in same-team sends, the verification call is pure waste because the server already returns a clean `unknown_recipient` error on miss with no side effects. The root cause is purely in the prompt-engineering layer: neither `list_agents` nor `send_message` tool descriptions explicitly forbid pre-flight verification, so the LLM's default defensive behavior kicks in.

## What Changes

- Modify `list_agents` MCP tool description to explicitly state it is **caller-team only**, that it **CANNOT** verify cross-team targets, and that it MUST NOT be used as a pre-flight check before `send_message`.
- Modify `send_message` (by-name) MCP tool description to explicitly state callers MUST NOT pre-verify the recipient via `list_agents`, and to surface that miss returns a clean `unknown_recipient` error.
- Modify MCP server `instructions` field (`ServerOptions.instructions`) to include a server-level anti-pattern paragraph reinforcing the same rule, so the constraint reaches every MCP session globally — not only when the LLM happens to read individual tool descriptions.
- Do NOT change server-side business logic. `SendMessageService.send` already returns `unknown_recipient` cleanly when the target is missing or in a different team (see `src/mcp/send-message.ts:63-130`).
- Do NOT change `broadcast`, `broadcast_to_role`, or `send_message_by_id` descriptions. Their pre-check failure modes have not been observed; treat them as out of scope to avoid churn.

## Capabilities

### New Capabilities
<!-- None. -->

### Modified Capabilities
- `agent-registry`: add a requirement that the `list_agents` tool description explicitly declares caller-team-only scope and forbids pre-flight verification before `send_message`.
- `mailbox`: add a requirement that the `send_message` (by-name) tool description explicitly forbids pre-verifying the recipient via `list_agents` and references the `unknown_recipient` return as the canonical miss signal.
- `mcp-transport`: add a requirement that the MCP server `instructions` field includes an anti-pattern paragraph forbidding `list_agents` pre-checks before `send_message`.

## Impact

- Affected code:
  - `src/mcp/tools.ts`: `SEND_MESSAGE_DESC` constant (lines ~105-114) and `list_agents` `registerTool` description (line ~729).
  - The module that constructs the `McpServer` with `instructions` (likely `src/mcp/transport.ts` per the file listing).
- No schema, no database, no API surface, no behavior changes — purely description / instructions text.
- Affected tests: add a small set of description-text assertions mirroring the existing patterns in `tests/send-message-description.test.ts` and `tests/tool-descriptions-poke-hint.test.ts`. No new test infrastructure.
- No breaking changes. Existing callers continue to work; the change only narrows the prose surface that the LLM consumes.
