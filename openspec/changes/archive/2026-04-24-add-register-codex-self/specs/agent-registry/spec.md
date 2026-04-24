## ADDED Requirements

### Requirement: register_codex_self tool registers the current session as a codex agent

The daemon SHALL expose an MCP tool `register_codex_self` that accepts `name` (required, non-empty), `thread_id` (optional UUID-like string), `ws_url` (optional, defaults to `ws://127.0.0.1:8799`), `auth_token_ref` (optional), `role` (optional), `team` (optional), `project_dir` (optional), and `model` (optional, defaults to `gpt`).  The tool SHALL always register the current MCP session as `client=\"codex\"` via the existing `RegisterCodexSelfService` pipeline, producing a `delivery.kind=\"codex-appserver\"` binding on success.  The schema SHALL NOT accept `ui_pid`, `tmux_pane_id`, `delivery`, `channel_session_id`, `base_url`, `session_id`, or `claude_ui_pid` — unknown keys MUST be rejected by strict zod.

#### Scenario: Happy path with thread_id
- **WHEN** a codex agent calls `register_codex_self({name:"gpt", thread_id:"019dbf73-e0d8-7cb1-a944-801df112b6e2"})`
- **THEN** the daemon connects to `ws://127.0.0.1:8799`, runs the codex `initialize` + `thread/resume` sequence for the supplied thread id, and writes an agents row with `client="codex"`, `delivery.kind="codex-appserver"`, `delivery_payload.thread_id=<supplied>`, `delivery_payload.ws_url="ws://127.0.0.1:8799"`
- **AND** the response includes `{agent_id, team, thread_id, ws_url}`

#### Scenario: ws_url default
- **WHEN** the agent calls `register_codex_self({name:"gpt", thread_id:"<uuid>"})` without `ws_url`
- **THEN** the daemon uses `ws://127.0.0.1:8799`
- **AND** the returned `ws_url` reflects that default

#### Scenario: ws_url environment override
- **GIVEN** the daemon process environment has `CROSS_AGENT_TEAMS_CODEX_WS_URL=ws://127.0.0.1:8899`
- **WHEN** the agent calls `register_codex_self({name:"gpt", thread_id:"<uuid>"})` without `ws_url`
- **THEN** the daemon uses the env override
- **AND** the returned `ws_url` is `ws://127.0.0.1:8899`

#### Scenario: Missing name is rejected
- **WHEN** the agent calls `register_codex_self({})`
- **THEN** the tool returns an `invalid_arguments`-class zod error citing the missing `name`
- **AND** no state is written

#### Scenario: ui_pid key is rejected by schema
- **WHEN** the agent calls `register_codex_self({name:"gpt", ui_pid: 42305})`
- **THEN** the tool returns a zod validation error listing `ui_pid` as an unrecognized key
- **AND** no state is written
- **AND** the error message is specific enough that the LLM can correct by dropping the field

#### Scenario: thread_id omitted returns the same candidate list as register_agent does today
- **WHEN** the agent calls `register_codex_self({name:"gpt"})` with no `thread_id`
- **AND** the daemon can connect to `ws://127.0.0.1:8799` but there is no unambiguous caller thread to pick
- **THEN** the tool returns the existing `{error:"thread_id_required", detail:{ws_url, thread_ids:[...]}}` envelope, identical to `register_agent({client:"codex", ws_url:"..."})` under the same conditions
- **AND** no agents row is created

#### Scenario: Re-register same identity returns the same agent_id
- **GIVEN** a previous `register_codex_self` call for `(team, name="gpt", role="default")` succeeded with `agent_id=A`
- **WHEN** the same MCP session calls `register_codex_self({name:"gpt", thread_id:"<uuid-B>"})` again
- **THEN** the response reuses `agent_id=A`
- **AND** the existing identity-reuse semantics of `RegisterCodexSelfService` apply unchanged

### Requirement: register_codex_self description guides codex agents toward env-driven self registration

The `register_codex_self` tool description SHALL explicitly instruct codex LLM callers to:
1. Read `$CODEX_THREAD_ID` from their tool shell environment and pass its value as the `thread_id` argument.
2. Omit `ui_pid` — UI pid discovery and tmux pane binding are handled by the launcher's pre-register flow (`pre_register_codex_pane`).
3. Pass `project_dir` when the user has not explicitly chosen a team, following the same default-team derivation as `register_agent` and `register_claude_self`.

The description SHALL NOT promise `ui_pid` semantics, MUST NOT mention `channel_session_id`, and MUST NOT suggest manual `ps` / `detect_tmux_pane` usage as a first resort.

#### Scenario: Tool description enumerates the CODEX_THREAD_ID guidance
- **WHEN** an MCP client enumerates `register_codex_self` via `tools/list`
- **THEN** the returned tool description contains the literal string `CODEX_THREAD_ID`
- **AND** it contains the literal string `pre_register_codex_pane` (or an equivalent reference to the pre-reg auto-bind mechanism)
- **AND** it does not contain the word `ui_pid` as a recommendation (may appear only as a warning/negation)

### Requirement: register_agent description discourages codex callers from passing ui_pid

The existing `register_agent` tool description SHALL include guidance that codex clients should prefer `register_codex_self` and should NOT pass `ui_pid`: the launcher's pre-register flow handles tmux pane binding, and manual `ui_pid` overrides the pre-reg auto-bind path.

#### Scenario: register_agent description points codex callers at register_codex_self
- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the returned description contains a hint along the lines of "codex clients should use `register_codex_self` and avoid passing `ui_pid`"

### Requirement: Top-level MCP server instructions add a codex section

The instructions string attached to the MCP `server.setInstructions` call (currently passing guidance for `xats` / team defaults / register-word protection) SHALL be extended with a codex-specific section instructing the LLM:
- If the caller's tool shell has `CODEX_THREAD_ID` set, that value is the local codex thread identifier and SHOULD be passed as `thread_id` when registering.
- Prefer `register_codex_self` over `register_agent` for codex clients.
- Do NOT attempt to discover or pass `ui_pid` — the daemon binds tmux pane through the `pre_register_codex_pane` pre-reg flow.

#### Scenario: Server instructions contain codex guidance
- **WHEN** an MCP client fetches the server info / instructions during the initialize handshake
- **THEN** the returned `instructions` string contains both `CODEX_THREAD_ID` and `register_codex_self`
- **AND** the existing `xats` / `register_agent` / `register_claude_self` guidance is preserved verbatim
