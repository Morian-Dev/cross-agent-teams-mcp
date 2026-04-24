## 1. Read-side validation (W1)

- [x] 1.1 Extend `parseDeliveryRow` in `src/lib/delivery-spec.ts` so it throws `corrupt_delivery_payload` when `delivery_kind` is not one of `DELIVERY_KINDS`
- [x] 1.2 In `parseDeliveryRow`, enforce variant-specific required fields: `claude-channel` requires non-empty string `channel_session_id`; `codex-appserver` requires non-empty string `thread_id` and non-empty string `ws_url`; `auth_token_ref` if present must be non-empty string
- [x] 1.3 Ensure the returned `DeliverySpec` is shaped strictly (no extra fields leak through the spread): for `claude-channel` return `{kind, channel_session_id}`; for `codex-appserver` return `{kind, thread_id, ws_url}` plus `auth_token_ref` only when present
- [x] 1.4 Add unit tests in `tests/delivery-spec.test.ts`: unknown `delivery_kind='irc'`; claude-channel with `delivery_payload='{}'`; claude-channel with `'{"channel_session_id":""}'`; codex-appserver missing `thread_id`; codex-appserver missing `ws_url`; codex-appserver with `auth_token_ref:''`
- [x] 1.5 Add a positive unit test that codex-appserver with full payload plus optional `auth_token_ref` reconstructs correctly

## 2. list_agents public projection (W2)

- [x] 2.1 Define a public delivery projection type (e.g. `PublicDelivery = {kind: 'none' | 'codex-appserver'} | {kind: 'claude-channel', channel_session_id: string}`) and a `toPublicAgentRow` helper colocated with the MCP layer (new file `src/mcp/agent-public-row.ts` OR inline in `src/mcp/tools.ts` — pick one in apply)
- [x] 2.2 Update `list_agents` handler in `src/mcp/tools.ts` to map each `AgentListRow` through the projection before returning
- [x] 2.3 Keep the top-level `channel_session_id: string | null` field in the projected row unchanged (derived from `delivery.kind === 'claude-channel'`)
- [x] 2.4 Confirm internal repo API (`AgentsRepo.getById`, `AgentsRepo.list`) still returns the full `DeliverySpec` — do not narrow these
- [x] 2.5 Update `tests/agents-repo-list-channel-session-id.test.ts` to assert the projection rules
- [x] 2.6 Add a test (new file or existing `list_agents` test) seeding a codex-appserver agent directly via `AgentsRepo.setDelivery`, calling `list_agents`, and asserting `delivery.kind === 'codex-appserver'`, absence of `delivery.thread_id`, `delivery.ws_url`, `delivery.auth_token_ref`
- [x] 2.7 Audit other `list_agents` tests and any test that asserts on `delivery` shape to confirm they still pass or update them to match the projected shape

## 3. Full test suite and validation

- [ ] 3.1 Run `pnpm test` and confirm all suites pass
- [ ] 3.2 Run `pnpm typecheck` and confirm no type errors
- [ ] 3.3 Run `openspec validate harden-delivery-read-path` and confirm it is valid
