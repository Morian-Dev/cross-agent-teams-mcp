## 1. Tool description text changes

- [x] 1.1 Append the anti-pre-check directive to `SEND_MESSAGE_DESC` in `src/mcp/tools.ts` (the `send_message` by-name variant only). The new sentence(s) MUST satisfy the three `mailbox` capability scenarios: contain `list_agents`, contain `unknown_recipient`, contain a `DO NOT` (or equivalent MUST NOT) paired with `pre` in the same sentence as `list_agents`, and make clear the rule applies to both same-team and cross-team sends.
- [x] 1.2 Replace the `list_agents` `registerTool` description string in `src/mcp/tools.ts` (currently `'List agents in the caller\'s team'`) with a longer description that satisfies all three `agent-registry` capability scenarios: declares caller-team-only scope, declares jussive inability to see cross-team agents, forbids pre-flight verification before `send_message` with a `DO NOT` + `pre` construction, and references `unknown_recipient` as the canonical miss signal.

## 2. MCP server instructions changes

- [x] 2.1 Extend the `instructions` string passed to `new McpServer(...)` in `src/mcp/transport.ts` (currently lines 66-72) with an appended anti-pattern paragraph. The paragraph MUST satisfy all four `mcp-transport` capability scenarios: contain `list_agents`, contain `send_message`, contain `unknown_recipient`, contain a `DO NOT` / `MUST NOT` paired with `pre` in the same sentence as `list_agents`, and declare caller-team scope for `list_agents`. The pre-existing required substrings (`xats`, `cross-agent-teams`, `project_dir`) MUST remain intact.

## 3. Tests for tool description text

- [x] 3.1 Add `tests/list-agents-description-no-precheck.test.ts` (or a similarly named file) asserting the registered `list_agents` tool description satisfies all three `agent-registry` capability scenarios. Follow the test pattern in `tests/tool-descriptions-poke-hint.test.ts` — register the tools, inspect the captured description string, assert substring presence with case-insensitive regex where the spec is case-insensitive.
- [x] 3.2 Add description assertions to `tests/send-message-description.test.ts` (or a new sibling file) covering all three `mailbox` capability scenarios. Reuse the existing test file's setup if it already constructs the registered tool list; otherwise mirror it.

## 4. Tests for MCP server instructions

- [x] 4.1 Add `tests/mcp-instructions-no-precheck.test.ts` (or extend an existing instructions test if one already covers the xats / project_dir scenarios) asserting all four `mcp-transport` capability scenarios pass against the live `instructions` string returned in the `initialize` response. The test MUST also re-assert the pre-existing required substrings (`xats`, `cross-agent-teams`, `project_dir`) to prove the new paragraph did not regress prior content.

## 5. Verification

- [x] 5.1 Run the full test suite (`npm test` or the project's standard command) and confirm all new tests pass and no existing tests regress.
- [x] 5.2 Run `openspec validate discourage-list-agents-precheck --strict` and confirm the change validates.
- [x] 5.3 Manually inspect the rendered `instructions` string at session `initialize` (e.g., via a one-off script or by reading the test output) and eyeball that the new paragraph reads cleanly alongside the existing content — no contradiction, no awkward run-on. This is a copy-edit pass, not a behavior check.
