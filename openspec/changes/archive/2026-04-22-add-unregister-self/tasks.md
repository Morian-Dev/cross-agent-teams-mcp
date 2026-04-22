## 1. Registry teardown

- [x] 1.1 Add unregister service/repo logic that validates in-progress tasks, deletes the caller's agent row, and removes contract subscriptions
- [x] 1.2 Wire the new `unregister_self` MCP tool into the server surface and return the specified success / error payloads

## 2. Session release

- [x] 2.1 Release the current MCP session's in-memory registered identity after successful unregister, including fanout / identity-claim cleanup
- [x] 2.2 Cover same-session post-unregister behavior so subsequent business tools return `unknown_agent`

## 3. Verification

- [x] 3.1 Add storage and MCP integration tests for successful unregister, task-blocked unregister, and re-registration after unregister
- [x] 3.2 Update user-facing tool descriptions or docs where needed so the new self-unregister path is discoverable
