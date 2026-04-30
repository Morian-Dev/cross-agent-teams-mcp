## REMOVED Requirements

### Requirement: register_claude_self mirrors register_agent team default derivation

**Reason**: The `register_claude_self` MCP tool is removed. Team default derivation continues to work for the equivalent `register_agent({agent_type:'claude-code', project_dir, ...})` call via the existing requirement "team is derived from basename of project_dir when team is omitted" (which already governs `register_agent` callers regardless of `agent_type`).

**Migration**: Replace `register_claude_self({name, project_dir, ...})` with `register_agent({agent_type:'claude-code', name, project_dir, ...})`.

### Requirement: register_claude_self auto-binds channel_session_id via ui_pid match

**Reason**: The `register_claude_self` MCP tool is removed. The auto-bind path is preserved on the `register_agent({agent_type:'claude-code', ui_pid, ...})` surface (see the modified "register_agent agent_type=claude-code auto-binds channel_session_id via ui_pid match" requirement, which now carries the full normative content rather than referencing the removed requirement).

**Migration**: Replace `register_claude_self({name, ui_pid, ...})` with `register_agent({agent_type:'claude-code', name, ui_pid, ...})`. Behavior is identical: ui_pid-only callers still get auto-bind; explicit `channel_session_id` callers still bypass auto-bind; non-matching ui_pid still leaves delivery at `'none'`; dead-sink proxy rows are still skipped.

### Requirement: register_codex_self tool registers the current session as a codex agent

**Reason**: The `register_codex_self` MCP tool is removed. The codex-appserver registration path remains reachable via `register_agent({agent_type:'codex', thread_id, ...})`, which routes through the unchanged `RegisterCodexSelfService.register(...)` backend inside `executeRegister`.

**Migration**: Replace `register_codex_self({name, thread_id, ...})` with `register_agent({agent_type:'codex', name, thread_id, ...})`. The `thread_id` argument is now REQUIRED at the schema layer (see the new "register_agent rejects agent_type='codex' without thread_id at schema layer" requirement); the previous `thread_id_required` candidate-list envelope is no longer returned.

### Requirement: register_codex_self description guides codex agents toward env-driven self registration

**Reason**: The `register_codex_self` MCP tool is removed. Equivalent guidance (read `$CODEX_THREAD_ID`, do not pass `ui_pid`, pass `project_dir`) is now part of the `register_agent` tool description's DETECTION block (see the new "register_agent tool description contains DETECTION block for agent types" requirement).

**Migration**: Codex callers consult the `register_agent` tool description directly. The DETECTION block names `CODEX_THREAD_ID` as the codex probe and instructs callers to set `agent_type="codex"` and pass the env value as `thread_id`.

### Requirement: register_agent description discourages codex callers from passing ui_pid

**Reason**: The recommendation to "prefer `register_codex_self`" is moot because that tool is removed. The "do not pass `ui_pid` from codex" guidance is preserved inside the new DETECTION block of the `register_agent` description (see the new DETECTION-block requirement).

**Migration**: None — guidance moved, not removed.

### Requirement: Top-level MCP server instructions add a codex section

**Reason**: The previous codex section recommended `register_codex_self`, which no longer exists. The replacement requirement (see the new "Top-level MCP server instructions describe register_agent agent_type= detection guidance") covers the same ground without naming any removed tool.

**Migration**: The MCP `serverInfo.instructions` string now mentions `register_agent` only; consumers that pattern-matched the substring `register_codex_self` in instructions must update to `register_agent` with `agent_type="codex"`.

## MODIFIED Requirements

### Requirement: register_agent agent_type=claude-code auto-binds channel_session_id via ui_pid match

When `register_agent({agent_type:'claude-code', ui_pid, ...})` is invoked AND the caller does NOT supply `channel_session_id` via the `delivery` field or any top-level csid argument, the daemon SHALL, after completing the identity UPSERT and any automatic runtime binding, perform a best-effort auto-bind of `delivery.kind='claude-channel'`:

1. Persist the caller's `ui_pid` onto the identity row as `runtime_ui_pid` (this already happens during ui_pid-based automatic runtime binding; when that path is skipped — e.g. tmux detection fails or already converged without ui_pid — the value MUST still be persisted on the row so auto-bind can subsequently find it).
2. Query: find a row where `role='__channel_proxy__'` AND `claude_ui_pid = <caller ui_pid>` AND `last_seen_at > now() - 5 minutes`, ordered by `last_seen_at DESC` with `LIMIT 1`. The query MUST NOT filter by team: the channel proxy always registers into `team='default'` per the `claude-channel-transport` startup sequence, while Claude Code hosts typically register into a project-derived team, so a team filter would prevent auto-bind in the common case. A single OS process (the caller's `ui_pid`) has exactly one channel proxy, so matching on `claude_ui_pid` alone uniquely identifies the correct proxy regardless of team membership.
3. If no row matches, no action is taken — the caller's delivery is left as its existing value (typically `'none'`).
4. If a row matches, extract `channel_session_id` from `delivery_payload`. If the csid also has a live `ChannelWakeFanout` sink attached in-memory, write the caller's `delivery_kind='claude-channel'` and `delivery_payload=json_object('channel_session_id', <csid>)` and include `channel_session_id: <csid>` in the response envelope. If the sink is not live, skip the write and behave as if no row matched.

This auto-bind path runs after the caller's identity row exists, before the response is returned. It is best-effort: failures or non-matches MUST NOT fail the `register_agent` call.

If the caller explicitly supplies `channel_session_id` (via `delivery.channel_session_id` or any top-level csid argument), the existing explicit-bind path (identical to `bind_channel` semantics) MUST continue to run, and the auto-bind path MUST NOT be attempted.

Callers with other agent types (`codex`, `opencode`, `custom`) are NOT affected by auto-bind — only `agent_type='claude-code'` triggers it.

#### Scenario: register_agent with agent_type=claude-code and ui_pid auto-binds when proxy row exists

- **GIVEN** a `__channel_proxy__` row exists with `team='default'`, `claude_ui_pid=25424`, `delivery_kind='claude-channel'`, `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`, and a live `ChannelWakeFanout` sink under `'csid-abc'`
- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', project_dir:'/Users/jt/workspace/cross-agent-teams-mcp', ui_pid:25424})` (no `channel_session_id`)
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'`
- **AND** the caller's `runtime_ui_pid` is `25424`

#### Scenario: register_agent with agent_type=claude-code without ui_pid does NOT auto-bind

- **GIVEN** a `__channel_proxy__` row exists for some proxy
- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', project_dir:'/Users/jt/workspace/cross-agent-teams-mcp'})` with no `ui_pid`
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='none'`

#### Scenario: register_agent with agent_type=claude-code and no matching proxy leaves delivery at none

- **GIVEN** no `__channel_proxy__` row has `claude_ui_pid=99999`
- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:99999})`
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='none'`

#### Scenario: register_agent with agent_type=claude-code skips auto-bind when proxy row's sink is dead

- **GIVEN** a `__channel_proxy__` row exists with `claude_ui_pid=25424` and `delivery.channel_session_id='csid-abc'`
- **AND** no `ChannelWakeFanout` sink is attached under `'csid-abc'` (the proxy's MCP session closed)
- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:25424})`
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_kind='none'` (no stale csid bound)

#### Scenario: explicit channel_session_id bypasses auto-bind entirely on register_agent

- **GIVEN** a `__channel_proxy__` row exists with `claude_ui_pid=25424` and `delivery.channel_session_id='csid-abc'` (live sink)
- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:25424, channel_session_id:'csid-explicit'})` and `'csid-explicit'` has a live sink attached
- **THEN** the call succeeds
- **AND** the caller's agents row has `delivery_payload='{\"channel_session_id\":\"csid-explicit\"}'` (explicit value wins, auto-bind did not run)

#### Scenario: auto-bind ignores team: proxy row in team A still matches caller in team B

- **GIVEN** a `__channel_proxy__` row exists with `team='default'`, `claude_ui_pid=25424`, `delivery.channel_session_id='csid-abc'`, and a live `ChannelWakeFanout` sink under `'csid-abc'`
- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', team:'alpha', ui_pid:25424})`
- **THEN** the caller's agents row is created in team `alpha` with `delivery_kind='claude-channel'` and `delivery_payload='{\"channel_session_id\":\"csid-abc\"}'` (proxy team `default` does NOT block the match; `claude_ui_pid` alone uniquely identifies the caller's proxy)

#### Scenario: register_agent with agent_type=codex does NOT auto-bind

- **GIVEN** a live `__channel_proxy__` row with `claude_ui_pid=25424` and `delivery.channel_session_id='csid-abc'` (live sink)
- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:'<uuid>', ui_pid:25424})`
- **THEN** the call succeeds
- **AND** the caller's agents row has its codex-specific delivery (or `delivery_kind='none'` if no codex delivery supplied) — it MUST NOT be set to `claude-channel`

### Requirement: runtime_ui_pid persisted on register_claude_self and register_agent agent_type=claude-code

When `register_agent({agent_type:'claude-code'})` is invoked with `ui_pid`, the daemon SHALL persist that value to the caller's `agents.runtime_ui_pid` column regardless of whether automatic tmux runtime binding converged. This makes `runtime_ui_pid` available to the reactive-rebind path (`claude-channel-transport`: "Proxy registration triggers reactive rebind of matching hosts") even in deployments where tmux binding was bypassed or failed.

#### Scenario: runtime_ui_pid persisted even when tmux detection does not converge

- **GIVEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:25424})`
- **AND** tmux pane detection returns `not_found`
- **WHEN** the tool completes successfully
- **THEN** the caller's agents row has `runtime_ui_pid=25424`
- **AND** the `tmux_pane_id` column is NULL

#### Scenario: runtime_ui_pid overwritten on subsequent re-registration with new ui_pid

- **GIVEN** agent `(default, opus)` already exists with `runtime_ui_pid=111`
- **WHEN** a new MCP session invokes `register_agent({agent_type:'claude-code', name:'opus', model:'opus-4-7', ui_pid:222})`
- **THEN** the row's `runtime_ui_pid` is now `222`

## ADDED Requirements

### Requirement: register_claude_self and register_codex_self tools removed from MCP tool surface

The daemon SHALL NOT register MCP tools named `register_claude_self` or `register_codex_self`. Both names MUST be absent from the `tools/list` response across all MCP transports (Streamable HTTP and stdio). Calls naming either tool MUST fail with the standard MCP `Method not found` (or equivalent unknown-tool) error.

The underlying `RegisterCodexSelfService` class SHALL remain in source and continue to back the `register_agent({agent_type:'codex', thread_id, ...})` route inside `executeRegister`. Only the MCP-tool wrappers are removed; backend services are unchanged.

#### Scenario: tools/list omits register_claude_self

- **WHEN** an MCP client enumerates tools via `tools/list`
- **THEN** the returned tool list does NOT contain an entry whose `name` equals `register_claude_self`

#### Scenario: tools/list omits register_codex_self

- **WHEN** an MCP client enumerates tools via `tools/list`
- **THEN** the returned tool list does NOT contain an entry whose `name` equals `register_codex_self`

#### Scenario: Calling register_claude_self returns method-not-found

- **WHEN** an MCP client calls `tools/call` with `name='register_claude_self'`
- **THEN** the response is an error envelope indicating the tool is not registered (the MCP runtime's standard unknown-tool error)
- **AND** no agents row is created or modified

#### Scenario: Calling register_codex_self returns method-not-found

- **WHEN** an MCP client calls `tools/call` with `name='register_codex_self'`
- **THEN** the response is an error envelope indicating the tool is not registered
- **AND** no agents row is created or modified

### Requirement: register_agent rejects agent_type="codex" without thread_id at schema layer

The Zod schema for `register_agent` SHALL reject any call where `agent_type='codex'` and `thread_id` is missing or an empty string. The rejection MUST happen at the schema-validation layer, BEFORE any backend service runs and BEFORE any agents row is written or read. The error message MUST mention `thread_id` and SHOULD direct launcher pre-reg callers to `pre_register_codex_pane` instead.

The previous `thread_id_required` candidate-list envelope (returned by the deleted `register_codex_self` tool when `thread_id` was omitted) is NOT preserved on the `register_agent` surface — that discovery affordance is replaced by the schema-level rejection plus the DETECTION block in the tool description.

#### Scenario: agent_type='codex' without thread_id is rejected by schema

- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5'})` with no `thread_id`
- **THEN** the response is a Zod validation error citing the missing `thread_id`
- **AND** no agents row is created
- **AND** no codex-appserver handshake is attempted

#### Scenario: agent_type='codex' with empty-string thread_id is rejected by schema

- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:''})`
- **THEN** the response is a Zod validation error citing the empty `thread_id`
- **AND** no agents row is created

#### Scenario: agent_type='codex' with valid thread_id passes schema and reaches the codex-appserver path

- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:'019dbf73-e0d8-7cb1-a944-801df112b6e2'})`
- **THEN** the call routes through `RegisterCodexSelfService.register(...)` inside `executeRegister` and writes `delivery.kind='codex-appserver'` on success
- **AND** the response includes `{agent_id, team, thread_id, ws_url}`

#### Scenario: Schema rejection error message names pre_register_codex_pane

- **WHEN** the schema rejects a `agent_type='codex'` call without `thread_id`
- **THEN** the error message string contains the literal substring `pre_register_codex_pane` (or an equivalent reference to launcher pre-reg) so the LLM can self-correct

### Requirement: register_agent({agent_type:'claude-code'}) defaults model via session client info sniff when omitted

When `register_agent` is invoked with `agent_type='claude-code'` and `model` is omitted, the daemon SHALL apply the same model-default it previously applied for `register_claude_self`: it sniffs the caller's MCP session client info (via the existing `getSessionClientInfo()` helper) and supplies the resulting Claude-specific default. The behavior of `register_agent` calls with explicit `model` is unchanged — the explicit value always wins.

#### Scenario: agent_type='claude-code' without model uses session-info-derived default

- **GIVEN** the MCP session's client info reports a Claude Code build whose default model is `'claude-opus-4-7'`
- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', ui_pid:25424})` with no `model`
- **THEN** the agents row is written with `model='claude-opus-4-7'` (or whatever `defaultClaudeSelfModel(getSessionClientInfo())` returns for that build)

#### Scenario: agent_type='claude-code' with explicit model preserves explicit value

- **WHEN** a caller invokes `register_agent({agent_type:'claude-code', name:'opus', model:'sonnet-4-6'})`
- **THEN** the agents row is written with `model='sonnet-4-6'` (the default-sniff path is NOT consulted)

### Requirement: register_agent({agent_type:'codex'}) defaults ws_url to empty string when omitted

When `register_agent` is invoked with `agent_type='codex'` and `ws_url` is omitted, the daemon SHALL set `ws_url=''` before invoking the codex-appserver path. The empty string is then resolved by `RegisterCodexSelfService` to either the env override (`CROSS_AGENT_TEAMS_CODEX_WS_URL`) or the built-in default (`ws://127.0.0.1:8799`), preserving the behavior previously specific to `register_codex_self`.

#### Scenario: agent_type='codex' without ws_url uses the built-in default

- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:'<uuid>'})` without `ws_url`
- **THEN** the daemon connects to `ws://127.0.0.1:8799`
- **AND** the returned `ws_url` reflects that default

#### Scenario: agent_type='codex' without ws_url honors environment override

- **GIVEN** the daemon process environment has `CROSS_AGENT_TEAMS_CODEX_WS_URL=ws://127.0.0.1:8899`
- **WHEN** a caller invokes `register_agent({agent_type:'codex', name:'gpt', model:'gpt-5', thread_id:'<uuid>'})` without `ws_url`
- **THEN** the daemon connects to the env-override URL
- **AND** the returned `ws_url` is `ws://127.0.0.1:8899`

### Requirement: register_agent tool description contains DETECTION block for agent types

The `register_agent` MCP tool description SHALL contain a clearly marked DETECTION block instructing LLM callers to determine `agent_type` by running a sequence of mechanical probes against their tool shell environment, in order, with first-match-wins semantics. Only TWO active probes SHALL be promoted; everything else falls through to a `agent_type="custom"` fallback:

1. `printenv CODEX_THREAD_ID` non-empty → `agent_type='codex'`, pass that value as `thread_id` (REQUIRED for codex per the Zod refinement); do NOT pass `ui_pid` (the launcher's `pre_register_codex_pane` flow handles tmux pane binding and supplying `ui_pid` from codex disables that path).
2. `printenv CLAUDECODE` non-empty OR `printenv CLAUDE_CODE_ENTRYPOINT` non-empty → `agent_type='claude-code'`; pass `$PPID` as `ui_pid` to enable channel auto-bind.
3. None of the above → `agent_type='custom'`, `agent_type_name=<the harness you are running under, e.g. cursor, opencode, ...>`. Detect the harness name from your runtime environment when you can — for example, `printenv CURSOR_TRACE_ID` non-empty is a cursor signal — but the DETECTION block MUST also explicitly warn against guessing agent type from system-wide signals like "binary X exists on PATH", because such probes detect what the user has installed, not what runtime the LLM is inside.

The DETECTION block's textual presence is the contract — implementers may reword the prose, but the description MUST contain:

- The two probe signals `CODEX_THREAD_ID` and `CLAUDECODE` or `CLAUDE_CODE_ENTRYPOINT`.
- The `agent_type="custom"` fallback rule with the `agent_type_name` requirement.
- A reference to `CURSOR_TRACE_ID` (or equivalent) as an example of how to derive `agent_type_name` for cursor under the custom fallback — NOT as a separate active probe.
- An anti-pattern warning against system-wide probes (the literal phrase "PATH" appearing alongside language about installed binaries vs. runtime identity is sufficient).

The description MUST NOT contain the previously promoted active probe `command -v opencode` (or any other "binary X is on PATH" probe). `agent_type='opencode'` remains a valid enum value for opencode-aware launchers but MUST NOT be promoted by any DETECTION probe.

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

The instructions string attached to the MCP `server.setInstructions` call SHALL describe registration in terms of `register_agent` only. It MUST mention:

- `register_agent` as the single registration entry point.
- That `agent_type="codex"` requires `thread_id` from `$CODEX_THREAD_ID`.
- That `agent_type="claude-code"` should pass `$PPID` as `ui_pid` for channel auto-bind.
- That ANY other harness (cursor, opencode, an editor extension, an unknown caller) uses `agent_type="custom"` with `agent_type_name=<harness name>`.
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

#### Scenario: instructions mention agent_type=custom fallback

- **WHEN** an MCP client fetches the server `instructions` during `initialize`
- **THEN** the `instructions` string mentions `agent_type="custom"` (or equivalent quoting) AND `agent_type_name`

### Requirement: register_agent treats model as truly optional regardless of agent type

The Zod schema for `register_agent` SHALL accept a missing `model` field for any value of `agent_type`. The previous schema rejection of `model === undefined && agent_type !== 'claude-code' && agent_type !== 'codex'` (with error message `'model is required'`) is removed. When `model` is omitted, the agents row's `model` column is persisted as SQL NULL.

For `agent_type='claude-code'` and `agent_type='codex'`, the existing default-injection rules in `executeRegister` still apply when the field is omitted (`defaultClaudeSelfModel(getSessionClientInfo())` and `'gpt'` respectively); for any other agent type (`opencode`, `custom`), omitted `model` means the column is left NULL.

The `register_agent` tool description and the MCP `serverInfo.instructions` string MUST state that `model` is OPTIONAL for any agent type.

#### Scenario: register_agent with agent_type='custom' and no model succeeds and stores NULL

- **WHEN** a caller invokes `register_agent({ agent_type: 'custom', agent_type_name: 'cursor', name: 'foo', project_dir: '/tmp/x' })` with no `model`
- **THEN** the call succeeds and returns `{ agent_id, team }`
- **AND** the agents row has `model IS NULL`

#### Scenario: register_agent with agent_type='claude-code' and no model still uses session-info default

- **GIVEN** the MCP session's client info reports a Claude Code build whose default model is `'claude-opus-4-7'`
- **WHEN** a caller invokes `register_agent({ agent_type: 'claude-code', name: 'opus', ui_pid: 25424 })` with no `model`
- **THEN** the agents row has `model = 'claude-opus-4-7'` (the existing claude-code default applies; the row is NOT NULL)

#### Scenario: register_agent with agent_type='codex' and no model still defaults to 'gpt'

- **WHEN** a caller invokes `register_agent({ agent_type: 'codex', name: 'gpt', thread_id: '<uuid>' })` with no `model`
- **THEN** the agents row has `model = 'gpt'` (the existing codex default applies)

#### Scenario: register_agent description states model is OPTIONAL for any agent type

- **WHEN** an MCP client enumerates `register_agent` via `tools/list`
- **THEN** the description string contains language indicating `model` is optional regardless of `agent_type` (the literal substring `OPTIONAL` paired with `model` is sufficient)
