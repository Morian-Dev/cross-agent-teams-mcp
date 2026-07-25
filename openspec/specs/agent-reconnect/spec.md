# agent-reconnect Specification

## Purpose

Let a `claude-code` agent that has lost its `(team, name)` identity (for example after a context clear) recover its prior local registration via the stable Claude UI process id (`$PPID`, stored as `runtime_ui_pid`), reusing the existing channel and pane binding paths rather than re-registering from scratch.
## Requirements
### Requirement: reconnect tool recovers identity by ui_pid

The daemon SHALL expose an MCP tool `reconnect` that takes `{ ui_pid: number }` and recovers a prior `claude-code` registration by reverse-looking-up the agents table on `runtime_ui_pid`. The lookup MUST be constrained to the daemon's configured local device label (the value `resolveLocalDevice` returns from `--device` / `os.hostname()`, falling back to the literal `'local'` only when no device label is configured) and MUST order candidate rows by `last_seen_at` descending. The daemon's local device label MUST be threaded into the lookup from daemon configuration (the same value `register_agent` uses), not hardcoded. The tool is intended for the post-context-clear case where the agent no longer knows its own `(team, name)` but the Claude UI process id (`$PPID`, stored as `runtime_ui_pid`) is unchanged.

`ui_pid` MUST be a positive integer; a missing or non-positive `ui_pid` MUST be rejected at the schema layer.

#### Scenario: Single match reuses identity and returns it

- **GIVEN** a daemon whose configured local device label is `D`
- **AND** exactly one agents row on `device = D` has `runtime_ui_pid = 25079` with `(team='default', name='xats-creator')` and `agent_id='X'`
- **WHEN** a new MCP session calls `reconnect({ ui_pid: 25079 })`
- **THEN** the response is `{ ok: true, agent_id: 'X', name: 'xats-creator', team: 'default', channel_session_id: <csid> }`
- **AND** the agents table still has exactly one row for `(team='default', name='xats-creator')` (no new row, same `agent_id='X'`)
- **AND** that row's `last_seen_at` is updated to the current timestamp
- **AND** that row's `registered_at` and `last_processed_event_id` are unchanged

#### Scenario: Lookup is scoped to the daemon's configured device label

- **GIVEN** a daemon started with `--device jt` (configured local device label `jt`)
- **AND** exactly one agents row on `device = 'jt'` has `runtime_ui_pid = 25079` with `(team='default', name='xats-creator')`
- **AND** no row exists on the literal `device = 'local'`
- **WHEN** a new MCP session calls `reconnect({ ui_pid: 25079 })`
- **THEN** the `(team='default', name='xats-creator')` identity is resolved and returned (the literal `'local'` filter MUST NOT cause a miss)

#### Scenario: ui_pid is validated at the schema layer

- **WHEN** a caller invokes `reconnect({ ui_pid: 0 })` or `reconnect({})`
- **THEN** the call is rejected with a schema validation error
- **AND** no agents row is read or mutated

### Requirement: reconnect performs cross-session takeover and re-binds channel and pane

On a single match, `reconnect` SHALL re-establish the identity through the same mechanisms `register_agent` uses: it MUST perform cross-session takeover (closing any prior MCP session still bound to that identity), re-bind the channel via the same `ui_pid`-driven auto-bind path, and re-bind the runtime pane via the same `ui_pid`-driven runtime-identity path. `reconnect` MUST NOT introduce new channel or pane binding logic; it reuses the existing paths.

#### Scenario: Prior session is taken over on reconnect

- **GIVEN** identity `(team='default', name='xats-creator')` is currently bound to an older MCP connection
- **WHEN** a new MCP session calls `reconnect({ ui_pid: 25079 })` matching that identity
- **THEN** the older MCP session's binding is released (cross-session takeover)
- **AND** the new MCP session becomes the active binding for `agent_id='X'`

#### Scenario: Channel session id is refreshed via ui_pid

- **GIVEN** a `__channel_proxy__` row exists for the same `ui_pid` carrying a fresh `channel_session_id`
- **WHEN** `reconnect({ ui_pid: 25079 })` succeeds
- **THEN** the matched agent's delivery is updated to the proxy's current `channel_session_id`
- **AND** the returned `channel_session_id` equals that value

### Requirement: reconnect returns need_register on zero matches

When no `device='local'` agents row matches `runtime_ui_pid = ui_pid`, `reconnect` SHALL return a `need_register` envelope that guides the caller to perform a normal `register_agent`. `reconnect` MUST NOT auto-register on a miss (single responsibility — it only reconnects existing identities).

#### Scenario: No prior identity for this ui_pid

- **GIVEN** no `device='local'` agents row has `runtime_ui_pid = 99999`
- **WHEN** a caller invokes `reconnect({ ui_pid: 99999 })`
- **THEN** the response indicates `need_register` with a human-readable reason
- **AND** no agents row is created or mutated

### Requirement: reconnect returns ambiguous candidates on multiple matches

When more than one `device='local'` agents row matches `runtime_ui_pid = ui_pid` (for example, the same UI process previously registered under two different names), `reconnect` SHALL return an `ambiguous` envelope listing the candidate identities ordered by `last_seen_at` descending, so the caller can let the user choose. `reconnect` MUST NOT silently pick one on its own.

#### Scenario: Two historical identities under one ui_pid

- **GIVEN** two `device='local'` agents rows share `runtime_ui_pid = 25079`: `(name='xats-creator', last_seen_at=T2)` and `(name='xats-tester', last_seen_at=T1)` with `T2 > T1`
- **WHEN** a caller invokes `reconnect({ ui_pid: 25079 })`
- **THEN** the response indicates `ambiguous`
- **AND** the candidate list contains both identities ordered with `xats-creator` first (most recent `last_seen_at`)
- **AND** no agents row is created or mutated

### Requirement: reconnect is scoped to local claude-code identities

`reconnect` SHALL only resolve identities on the daemon's configured local device label (the host the `ui_pid` is meaningful on), because `ui_pid` is a process id meaningful solely on that host. Rows on any other device label MUST NOT be matched. Codex reconnect (which is keyed on `thread_id`, not `ui_pid`) is out of scope for this tool.

#### Scenario: Rows on a different device are not matched

- **GIVEN** a daemon whose configured local device label is `D`
- **AND** an agents row with the same `runtime_ui_pid` value but `device != D`
- **WHEN** a caller invokes `reconnect({ ui_pid: <that value> })`
- **THEN** that other-device row is not considered a match
- **AND** if no row on `device = D` matches, the response indicates `need_register`

### Requirement: reconnect tool description guides invocation on reconnect phrases

The `reconnect` tool's MCP description SHALL instruct the agent to invoke it when the user asks to reconnect or re-register to xats — covering at least the phrases "reconnect xats", "re-register xats", "重连 xats", and "重新注册 xats" — passing the Claude UI process id (`$PPID`) as `ui_pid`. The description SHALL ALSO route automatic re-establishment after a resume / channel re-attach by **whether the agent still remembers its own `(team, name)`**, NOT by whether `$PPID` is unchanged (a condition the agent cannot self-evaluate):

- When the agent does NOT remember its `(team, name)` (for example after a context clear, where `$PPID` is unchanged), the description SHALL guide `reconnect({ ui_pid: $PPID })` as the path to recover identity by process id and rebind the new `channel_session_id` in one step, preferred over the `bind_channel`→`register_agent` fallback.
- When the agent DOES remember its `(team, name)` (for example after closing Claude Code and resuming the conversation, where `$PPID` has changed but the context survived), the description SHALL guide `register_agent` with the remembered `(team, name)` and the current `$PPID` instead of `reconnect` — because `reconnect` reverse-looks-up the changed `$PPID`, finds no match, and returns `need_register`.

#### Scenario: Description lists the trigger phrases and the ui_pid source

- **WHEN** the registered `reconnect` tool's description is inspected
- **THEN** it names the reconnect/re-register trigger phrases (including the Chinese "重连 xats" / "重新注册 xats")
- **AND** it states that `ui_pid` is the Claude UI process id (`$PPID`)
- **AND** it states that `reconnect` is the path to re-establish after a context clear when the agent no longer remembers its `(team, name)` and `$PPID` is unchanged

#### Scenario: Description routes remembered-identity resume to register, not reconnect

- **WHEN** the registered `reconnect` tool's description is inspected
- **THEN** it states that an agent which still remembers its `(team, name)` after a restart + resume (changed `$PPID`) should `register_agent` with that remembered identity rather than call `reconnect`
- **AND** it does NOT instruct the agent to use `reconnect` "even when it still remembers its `(team, name)`"

### Requirement: reconnect recovers kimi-code identity by base_url and session_id

`reconnect({ agent_type: 'kimi-code', base_url, session_id })` SHALL recover a kimi-code identity, mirroring the opencode shape: reverse-look-up local agents rows whose delivery is `{ kind: 'kimi-server' }` matching the given `(base_url, session_id)` pair, and rebind the calling MCP session to the single matching identity.

`agent_type` is the explicit runtime discriminator of the base_url arm: with `agent_type='kimi-code'` the dispatch MUST be deterministic — an empty or non-matching registry returns the kimi `need_register`, never an opencode-flavored probe error. Without `agent_type`, the daemon MAY fall back to local row residency to route legacy base_url callers, but this heuristic MUST NOT be the documented path for kimi recovery (an empty registry is then indistinguishable from an opencode target).

Unlike opencode, `session_id` is REQUIRED for the kimi path: the daemon MUST NOT auto-resolve "the most recent session" for kimi, for the same reason registration refuses to guess — several kimi sessions routinely share a workDir, and binding the wrong one delivers pokes to a session nobody is watching while reporting success.

Before reusing the identity the daemon MUST revalidate the session against the kimi server: `GET <base_url>/api/v1/sessions/<session_id>` with the bearer token resolved exactly as the poke dispatcher resolves it (delivery `auth_token_ref`, else the kimi token file). A 2xx response alone is NOT sufficient: the body MUST be a strict kimi success envelope — object root with `code` exactly 0 and an object `data` (a bare 2xx JSON object without that envelope, a root-level `id`, `data: null`, or an array `data` all fail) — and the envelope MUST identify the requested session (`data.id` equal to the requested `session_id`) and MUST NOT be archived. On a missing/archived/mismatched session or a failed probe, reconnect SHALL return `session_not_found` and MUST NOT mutate any agents row or binding.

The kimi `session_id` argument only needs to be non-blank and is NORMALIZED (trimmed) at the schema layer on both register and reconnect, so registration responses, stored rows, and reconnect lookups all agree on one value — reconnect MUST NOT impose a stricter format (such as the opencode `ses` prefix) that would make a legally registered row unrecoverable. Base URLs are compared canonically on BOTH sides of the lookup — the caller's argument and the stored payload value are each passed through the shared canonicalizer — so equivalent spellings of one endpoint recover the same row, including rows persisted before canonicalization existed. A kimi `base_url` carrying a query, fragment, userinfo, or a bare trailing `?`/`#` is rejected at the schema layer, mirroring registration.

On zero matching rows, reconnect SHALL return `need_register`. On success it SHALL rebind the current connection under the recovered identity's stable runtime key (the kimi `(base_url, session_id)` pair), so the recovered connection co-exists with — rather than takes over — any live engine connection of the same session.

#### Scenario: kimi identity recovered and rebound

- **GIVEN** a local agents row `(default, kimi-1)` with delivery `{ kind: 'kimi-server', session_id: 'S', base_url: 'http://127.0.0.1:58627' }`
- **AND** the kimi server reports session `S` exists
- **WHEN** a fresh MCP session calls `reconnect({ base_url: 'http://127.0.0.1:58627', session_id: 'S' })`
- **THEN** the response carries the row's `(team, name, agent_id)`
- **AND** the calling session is bound to that `agent_id`

#### Scenario: Stale session id does not rebind

- **GIVEN** the same row, but the kimi server reports session `S` does not exist (or the probe fails)
- **WHEN** `reconnect({ base_url, session_id: 'S' })` is called
- **THEN** the response is `session_not_found`
- **AND** no agents row or binding is mutated

#### Scenario: A 2xx envelope that does not identify the session does not rebind

- **GIVEN** the same row, but the probe returns HTTP 200 with body `{}`, a root-level `{"id": "S"}` without the `{code: 0, data: {...}}` envelope, `data: null`, a session object whose `id` differs from `S`, or one with `archived: true`
- **WHEN** `reconnect({ base_url, session_id: 'S' })` is called
- **THEN** the response is `session_not_found`
- **AND** no agents row or binding is mutated

#### Scenario: No matching row asks for registration

- **GIVEN** no local `kimi-server` row matches `(base_url, session_id)` — including a completely empty registry
- **WHEN** `reconnect({ agent_type: 'kimi-code', base_url, session_id })` is called
- **THEN** the response indicates `need_register` (never an opencode-flavored probe error)

#### Scenario: session_id is required for the kimi path

- **GIVEN** a caller supplying a kimi `base_url` without `session_id` in a context where the base_url hosts kimi-server rows
- **WHEN** the daemon resolves the reconnect
- **THEN** the kimi rows are not auto-resolved by recency; recovery of a kimi identity without an explicit `session_id` is refused

