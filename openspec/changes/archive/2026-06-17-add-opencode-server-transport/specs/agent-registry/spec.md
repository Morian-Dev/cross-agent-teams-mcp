## MODIFIED Requirements

### Requirement: register_agent tool description contains DETECTION block for agent types

The `register_agent` MCP tool description SHALL contain a clearly marked DETECTION block instructing LLM callers to determine `agent_type` by running a sequence of mechanical probes against their tool shell environment, in order, with first-match-wins semantics. THREE active probes SHALL be promoted; everything else falls through to a `agent_type="custom"` fallback:

1. `printenv OPENCODE_XATS_BASE_URL` non-empty → `agent_type='opencode'`; pass that value as `base_url`. Do NOT pass `session_id` — the daemon auto-resolves it as the most recently updated session on that base_url. The env var is set ONLY by the `free-xats-opencode` launcher, so its presence is itself the runtime assertion that the caller is opencode.
2. `printenv CODEX_THREAD_ID` non-empty → `agent_type='codex'`, pass that value as `thread_id` (REQUIRED for codex per the Zod refinement); do NOT pass `ui_pid` (the launcher's `pre_register_codex_pane` flow handles tmux pane binding and supplying `ui_pid` from codex disables that path).
3. `printenv CLAUDECODE` non-empty OR `printenv CLAUDE_CODE_ENTRYPOINT` non-empty → `agent_type='claude-code'`; pass `$PPID` as `ui_pid` to enable channel auto-bind.
4. None of the above → `agent_type='custom'`, `agent_type_name=<the harness you are running under, e.g. cursor, ...>`. Detect the harness name from your runtime environment when you can — for example, `printenv CURSOR_TRACE_ID` non-empty is a cursor signal — but the DETECTION block MUST also explicitly warn against guessing agent type from system-wide signals like "binary X exists on PATH", because such probes detect what the user has installed, not what runtime the LLM is inside.

The DETECTION block's textual presence is the contract — implementers may reword the prose, but the description MUST contain:

- The three env-based probe signals `OPENCODE_XATS_BASE_URL`, `CODEX_THREAD_ID`, and `CLAUDECODE` or `CLAUDE_CODE_ENTRYPOINT`.
- The `agent_type="custom"` fallback rule with the `agent_type_name` requirement.
- A reference to `CURSOR_TRACE_ID` (or equivalent) as an example of how to derive `agent_type_name` for cursor under the custom fallback — NOT as a separate active probe.
- An anti-pattern warning against system-wide probes (the literal phrase "PATH" appearing alongside language about installed binaries vs. runtime identity is sufficient).
- An explicit opencode branch that instructs callers to pass `agent_type='opencode'` with `base_url=$OPENCODE_XATS_BASE_URL`, and to OMIT `session_id` (daemon auto-resolves) unless the caller has an explicit override.

The description MUST NOT contain the previously promoted active probe `command -v opencode` (or any other "binary X is on PATH" probe). The `OPENCODE_XATS_BASE_URL` env-based probe is the ONLY sanctioned mechanism for promoting `agent_type='opencode'`; PATH-based probes remain rejected because they assert runtime identity from system-wide state instead of session-local state.

#### Scenario: tools/list returns register_agent description containing OPENCODE_XATS_BASE_URL probe

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains the literal substring `OPENCODE_XATS_BASE_URL`
- **AND** that substring appears in the DETECTION block as the env-var probe for `agent_type='opencode'`

#### Scenario: tools/list returns register_agent description containing CODEX_THREAD_ID probe

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains the literal substring `CODEX_THREAD_ID`

#### Scenario: tools/list returns register_agent description containing CLAUDECODE probe

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains the literal substring `CLAUDECODE` OR `CLAUDE_CODE_ENTRYPOINT`

#### Scenario: tools/list returns register_agent description does NOT promote opencode binary probe

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string does NOT contain the literal substring `command -v opencode`
- **AND** the description string does NOT contain any clause that suggests choosing `agent_type='opencode'` based on the presence of an `opencode` binary on PATH

#### Scenario: tools/list returns register_agent description containing custom fallback rule

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains the literal substring `agent_type="custom"` (or equivalent) AND `agent_type_name` paired with a "required when agent_type=custom" or "your harness name" clause

#### Scenario: tools/list returns register_agent description containing anti-pattern warning

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains language warning against system-wide probes (the literal substring `PATH` appears together with wording that contrasts what the user has installed with what runtime the LLM is inside)

#### Scenario: register_agent description does not name the removed self tools

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string does NOT contain the literal substring `register_claude_self`
- **AND** does NOT contain the literal substring `register_codex_self`

### Requirement: Top-level MCP server instructions describe register_agent with agent_type= detection guidance

The instructions string attached to the MCP `server.setInstructions` call SHALL describe registration in terms of `register_agent` only.  It MUST mention:

- `register_agent` as the single registration entry point.
- That `agent_type="opencode"` is selected when `OPENCODE_XATS_BASE_URL` is non-empty, and that callers pass that value as `base_url` (daemon auto-resolves `session_id`).
- That `agent_type="codex"` requires `thread_id` from `$CODEX_THREAD_ID`.
- That `agent_type="claude-code"` should pass `$PPID` as `ui_pid` for channel auto-bind.
- That ANY other harness (cursor, an editor extension, an unknown caller) uses `agent_type="custom"` with `agent_type_name=<harness name>`.
- An anti-pattern warning that mirrors the DETECTION block: callers MUST NOT guess from system-wide signals like "binary X is on PATH" because that reflects what the user has installed, not what runtime the LLM is inside.

The instructions string MUST NOT contain the literal substrings `register_claude_self` or `register_codex_self`.

The `xats` abbreviation guidance and the `project_dir` team-default convention from the existing instructions string are preserved (covered by `mcp-transport`'s instructions requirement).

#### Scenario: instructions contain register_agent only

- **WHEN** an MCP client fetches the server `instructions` during `initialize`
- **THEN** the `instructions` string contains the literal substring `register_agent`
- **AND** does NOT contain the literal substring `register_claude_self`
- **AND** does NOT contain the literal substring `register_codex_self`

#### Scenario: instructions mention CODEX_THREAD_ID for codex callers

- **WHEN** an MCP client fetches the server `instructions` during `initialize`
- **THEN** the `instructions` string contains the literal substring `CODEX_THREAD_ID`

#### Scenario: instructions mention OPENCODE_XATS_BASE_URL for opencode callers

- **WHEN** an MCP client fetches the server `instructions` during `initialize`
- **THEN** the `instructions` string contains the literal substring `OPENCODE_XATS_BASE_URL`

#### Scenario: instructions mention agent_type=custom fallback

- **WHEN** an MCP client fetches the server `instructions` during `initialize`
- **THEN** the `instructions` string mentions `agent_type="custom"` (or equivalent quoting) AND `agent_type_name`

## ADDED Requirements

### Requirement: register_agent({agent_type:'opencode'}) resolves session_id and writes opencode-server delivery

The daemon SHALL handle `register_agent({agent_type:'opencode'})` as a dedicated branch in `executeRegister`, distinct from the `codex` and `claude-code` branches. The following normative rules apply:

1. `base_url` MUST be a non-empty `http://` or `https://` URL. The Zod schema SHALL reject calls where `base_url` is missing, empty, or not parseable as an http/https URL, BEFORE any backend service runs and BEFORE any agents row is written or read.
2. `session_id` is OPTIONAL. If the caller supplies it, it MUST be a non-empty string starting with `ses` (Zod rejection otherwise). If omitted, the daemon SHALL resolve it by `GET <base_url>/session` and selecting the entry with the largest `time_updated` value. If the session list is empty, return `{ error: 'no_active_session', detail: { base_url } }`.
3. The daemon SHALL `GET <base_url>/global/health` before session resolution; if it fails (network error or non-2xx), return `{ error: 'opencode_unreachable', detail: { base_url, cause: <message> } }` and do NOT write any agents row.
4. `auth_token_ref` is OPTIONAL; when supplied it MUST be a trimmed non-empty string and is propagated verbatim into the persisted `delivery_payload`.
5. On success, the daemon writes `delivery={kind:'opencode-server', session_id, base_url, auth_token_ref?}` on the caller's agents row via the `agent-delivery` persistence rules (`UPDATE agents SET delivery_kind='opencode-server', delivery_payload=...`).
6. The successful response envelope SHALL be `{ agent_id, team, session_id, base_url }`. The `session_id` is always present (either caller-supplied or daemon-resolved) so the agent can echo it back to the user.

The schema rejection error message for missing/malformed `base_url` SHOULD reference `OPENCODE_XATS_BASE_URL` so an LLM that forgot to read its environment can self-correct.

This requirement supersedes the previously-deleted `register_opencode_self` tool (which was removed in 2026-04-30). That tool's failure mode was opencode runtime self-identification; the env-var-driven DETECTION block in `register_agent`'s tool description is the sound replacement.

#### Scenario: register_agent({agent_type:'opencode'}) with explicit session_id writes delivery

- **GIVEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', team:'default', base_url:'http://127.0.0.1:18888', session_id:'ses_xyz'})`
- **AND** `GET http://127.0.0.1:18888/global/health` returns `{"healthy":true,...}`
- **THEN** the agents row is written with `delivery_kind='opencode-server'` and `delivery_payload='{"session_id":"ses_xyz","base_url":"http://127.0.0.1:18888"}'`
- **AND** the response is `{ agent_id: <uuid>, team: 'default', session_id: 'ses_xyz', base_url: 'http://127.0.0.1:18888' }`

#### Scenario: register_agent({agent_type:'opencode'}) without session_id auto-resolves most recent

- **GIVEN** `GET http://127.0.0.1:18888/session` returns sessions `[{id:'ses_a', time_updated: 1000}, {id:'ses_b', time_updated: 2000}, {id:'ses_c', time_updated: 1500}]`
- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'http://127.0.0.1:18888'})`
- **THEN** the agents row is written with `delivery_payload` containing `session_id='ses_b'`
- **AND** the response `session_id` is `'ses_b'`

#### Scenario: register_agent({agent_type:'opencode'}) returns no_active_session when session list is empty

- **GIVEN** `GET http://127.0.0.1:18888/session` returns `[]`
- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'http://127.0.0.1:18888'})`
- **THEN** the response is `{ error: 'no_active_session', detail: { base_url: 'http://127.0.0.1:18888' } }`
- **AND** no agents row is written or modified

#### Scenario: register_agent({agent_type:'opencode'}) returns opencode_unreachable when health check fails

- **GIVEN** `GET http://127.0.0.1:9999/global/health` rejects (connection refused)
- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'http://127.0.0.1:9999'})`
- **THEN** the response is `{ error: 'opencode_unreachable', detail: { base_url: 'http://127.0.0.1:9999', cause: <string> } }`
- **AND** no agents row is written
- **AND** no session-list HTTP request is sent

#### Scenario: register_agent({agent_type:'opencode'}) schema rejects missing base_url

- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1'})` with no `base_url`
- **THEN** the response is a Zod validation error citing the missing `base_url`
- **AND** no HTTP request is sent
- **AND** no agents row is written

#### Scenario: register_agent({agent_type:'opencode'}) schema rejects malformed base_url

- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'not-a-url'})`
- **THEN** the response is a Zod validation error citing the malformed `base_url`
- **AND** no HTTP request is sent

#### Scenario: register_agent({agent_type:'opencode'}) schema rejects ws:// base_url

- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'ws://127.0.0.1:18888'})`
- **THEN** the response is a Zod validation error citing the malformed `base_url`

#### Scenario: register_agent({agent_type:'opencode'}) schema rejects invalid session_id

- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'http://127.0.0.1:18888', session_id:'abc'})`
- **THEN** the response is a Zod validation error citing the malformed `session_id`
- **AND** no HTTP request is sent

#### Scenario: register_agent({agent_type:'opencode'}) preserves auth_token_ref in delivery

- **GIVEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'http://127.0.0.1:18888', auth_token_ref:'OPENCODE_SERVER_PASSWORD'})` and the health check passes
- **WHEN** the agents row is written
- **THEN** `delivery_payload` JSON-decodes to an object containing `auth_token_ref: 'OPENCODE_SERVER_PASSWORD'`

### Requirement: register_agent({agent_type:'opencode'}) defaults model to NULL when omitted

When `register_agent` is invoked with `agent_type='opencode'` and `model` is omitted, the daemon SHALL persist `model = NULL` on the agents row. The opencode branch has no model-default inference (unlike `claude-code`'s session-info sniff or `codex`'s `'gpt'` default) because opencode sessions are model-agnostic at registration time. An explicit `model` value always wins.

#### Scenario: agent_type='opencode' without model persists NULL

- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'http://127.0.0.1:18888'})` with no `model`
- **AND** the call succeeds
- **THEN** the agents row has `model IS NULL`

#### Scenario: agent_type='opencode' with explicit model preserves value

- **WHEN** a caller invokes `register_agent({agent_type:'opencode', name:'oc-1', base_url:'http://127.0.0.1:18888', model:'glm-5.2'})`
- **THEN** the agents row has `model='glm-5.2'`
