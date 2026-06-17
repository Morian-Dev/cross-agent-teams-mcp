## Context

`cross-agent-teams-mcp` (xats) currently delivers wake-up pokes to opencode agents through generic tmux paste/Enter — the fallback path that `dispatchUnknown` provides for any agent with a `tmux_pane_id` but no dedicated transport. This works, but is a strictly worse experience than what claude-code (`<channel>` tag injection) and codex (`turn/start` over app-server websocket) get: tmux paste pollutes the TUI input buffer, requires the opencode process to be in a foreground tmux pane, and cannot carry structured payloads.

A previous `opencode-server` HTTP transport (added early, deleted in `2026-04-30-drop-opencode-server-transport`) tried to fix this and failed. The post-mortem (`archive/.../design.md:11`) names the root cause: *"The handshake depends on opencode reliably self-identifying as opencode inside its own MCP session so the daemon can correlate the TUI with the pre-registered pane. That premise does not hold."* The fix at the time was to delete everything.

Meanwhile the actual API surface is fine and has only improved: opencode's HTTP server (started by `opencode --port <N>` or `opencode serve`) exposes `POST /session/{id}/prompt_async` with a `{parts:[{type:'text', text}], noReply:true}` body, returning `204` on accepted and injecting the prompt as a real user message into the target session. The TUI renders the resulting conversation in real time. This is structurally identical to Codex's `turn/start`: send prompt → session agent processes it asynchronously.

The real problem is identity discovery: how does the daemon learn the `(base_url, session_id)` pair for the calling opencode agent? Three verified facts drive the new design:

1. **opencode does NOT auto-inject session identity into its MCP subprocess.** Binary strings scan: no `OPENCODE_SESSION_ID` env var; the `x-opencode-session` header exists but is only attached to outbound LLM-provider calls, never to MCP-server calls (whether local-spawn or remote-HTTP).
2. **opencode TUI + explicit `--port <N>` DOES start the HTTP server** (verified: `opencode --port 18888` made `/global/health` return `{"healthy":true,"version":"1.17.7"}` while TUI was fully interactive). Default `--port 0` does NOT start the server.
3. **agent's Bash tool inherits opencode's full process environment.** Verified: env vars exported by the launching shell are visible via `printenv` from inside the agent's Bash tool calls. This is the same channel Codex uses (`CODEX_THREAD_ID`).

The shape of the solution follows: a launcher wrapper sets an env var; the agent reads it and explicitly passes it into `register_agent`; the daemon uses it to reach the agent's HTTP server.

## Goals / Non-Goals

**Goals:**
- Give opencode a first-class poke delivery transport on equal footing with codex-appserver: structured, async, no tmux dependency, no input-buffer pollution.
- Reuse the existing `register_agent` entry point — no new top-level MCP tool. The user-facing prompt stays minimal: `name` + `team`.
- Zero reconfiguration of the user's global `AGENTS.md`. The MCP tool description itself guides opencode agents to the right DETECTION branch.
- Delete the now-misleading `2026-04-30-drop-opencode-server-transport` archive entry so its failure post-mortem doesn't anchor future readers on a dissolved premise.

**Non-Goals:**
- No TUI toast / desktop notification side-channels. One delivery path: HTTP `prompt_async`.
- No tmux fallback for `agent_type='opencode'` registrations. The launcher guarantees a live HTTP server; if it is unreachable, the poke fails loudly (parallel to codex-appserver's no-fallback behavior).
- No session-switch rebind. If the user `/sessions`-switches to another session mid-conversation, the bound `session_id` goes stale and the user must re-register. Documented; not auto-handled. (User explicitly stated this is an unusual workflow.)
- No `pre_register_opencode_pane`-style tmux pre-registration. The launcher does not touch the daemon at all; the agent's `register_agent` call is the only registration event.
- No multi-session awareness. Each `register_agent({agent_type:'opencode'})` binds exactly one `session_id` per agent row, selected as the most recently updated session on `base_url` at register time.
- No `BREAKING` removal of the existing opencode-as-custom flow. Callers that still pass `agent_type='custom'` with `agent_type_name='opencode'` continue to route through tmux — the new path is strictly additive.

## Decisions

### D1. Launcher-injected env var dissolves the "self-identification" failure mode

**Chosen:** a zsh function `free-xats-opencode` (mirroring the existing `free-xats-codex`) finds an idle localhost port, exports `OPENCODE_XATS_BASE_URL=http://127.0.0.1:<port>`, and `exec`s `opencode --port <port> --hostname 127.0.0.1 "$@"`. The agent reads this env via its Bash tool and explicitly passes the value into `register_agent({agent_type:'opencode', base_url})`.

**Rationale:** this directly inverts the 2026-04-30 failure. The old transport required opencode's runtime to assert "I am opencode" from inside its MCP session, which was unreliable. The new approach requires no such assertion — the env var only exists when the user opted into the xats launcher, so its presence is itself the assertion. Identity becomes an explicit function argument, not an inferred runtime property.

**Alternatives considered:**
- *Local MCP subprocess with env injection* — rejected because the daemon is configured as `type:"remote"` in `opencode.json`; switching to `type:"local"` would force the daemon to be spawned by opencode, breaking the single-shared-daemon model.
- *opencode SDK / OpenAPI client in the daemon* — rejected; overkill. Plain `fetch` against `/global/health`, `/session`, `/session/:id/prompt_async` is sufficient.
- *Daemon scans localhost ports to find opencode servers* — rejected; racy and imposes daemon-side polling load.

### D2. New `agent_type='opencode'` enum value (not custom + agent_type_name)

**Chosen:** add `'opencode'` as a first-class enum value in `register_agent`'s `agent_type`, parallel to `'claude-code'` and `'codex'`. The DETECTION ladder in the tool description gains a step 0 (before the existing codex/claude-code/custom steps): `printenv OPENCODE_XATS_BASE_URL` non-empty → `agent_type="opencode"`, pass value as `base_url`.

**Rationale:** mirrors the codex precedent (`printenv CODEX_THREAD_ID` → `agent_type="codex"`). Keeping opencode on `agent_type='custom'` would force `if (agent_type_name === 'opencode')` special-casing inside the daemon, which is the same complexity spread across two fields. `'opencode'` is already a valid `ClientKind` label, so this aligns the public surface with internal taxonomy.

**Alternative considered:** keep opencode on custom + agent_type_name. Rejected per user direction (decision 1.A in explore) — symmetric enum is cleaner.

### D3. HTTP protocol mapping mirrors codex-appserver line-for-line

**Chosen:** the new `opencode-server-dispatch.ts` follows `codex-appserver-dispatch.ts` structurally. The protocol mapping:

| step | codex-appserver (existing) | opencode-server (new) |
|------|---------------------------|------------------------|
| establish | WebSocket to `ws_url` (with optional bearer) | none (stateless HTTP) |
| handshake | `initialize` → `initialized` | none |
| target | `thread/resume` | none (session_id bound at register time) |
| inject | `turn/start({input:[{type:text, text}]})` | `POST /session/:id/prompt_async` body `{parts:[{type:text, text}], noReply:true}` |
| close | `safeClose(ws)` | none |

Auth: if `auth_token_ref` resolves to a non-empty env var, send as `Authorization: Bearer <token>` on the POST. Default (no auth_token_ref) assumes an unsecured server (`OPENCODE_SERVER_PASSWORD` unset).

**Rationale:** minimizing protocol-step count maximizes reliability. opencode's HTTP API needs no handshake, no resume, no close — strictly fewer failure modes than codex-appserver.

### D4. `session_id` resolution: daemon picks most-recently-updated session on `base_url`

**Chosen:** when `register_agent({agent_type:'opencode', base_url})` is called without `session_id`, the daemon issues `GET <base_url>/session` and selects the session with the largest `time_updated` value. If the list is empty, returns `{error:'no_active_session', detail:{base_url}}`. Callers MAY pass an explicit `session_id` to override.

**Rationale:** the calling agent's session is, by construction, the most recently active session on that base_url at register time (the agent just made a Bash tool call → emitted an event → updated `time_updated`). Auto-selection removes one more user-visible field. Parallels codex's `thread_id_required` fallback shape but goes one step further by auto-picking rather than asking the agent to disambiguate.

**Risk:** a concurrent second opencode session on the same base_url (multi-window against one server) could race. Mitigation: the launcher picks a unique port per opencode instance, so each `base_url` corresponds to exactly one TUI process and one current session. Multi-window against one server is an unsupported config.

**Alternative considered:** require explicit `session_id`. Rejected because the agent would need to call `/session` itself, parse JSON, and pick — pushing daemon-side logic into every agent. Codex auto-listing (`thread_id_required`) showed the pattern works.

### D5. No tmux fallback for `delivery.kind='opencode-server'`

**Chosen:** transport-dispatch's `'opencode-server'` branch invokes the HTTP dispatcher and returns its result directly. If the dispatcher returns `{error:'opencode_connect_failed', ...}`, that error propagates without trying tmux.

**Rationale:** matches codex-appserver's no-fallback behavior. The launcher guarantees a live server; if it is down, silent tmux fallback would mask the real failure (server crashed, port stolen, etc.) and the user would see mysterious double-input (one paste from tmux, one prompt_async from the daemon when it recovers).

### D6. Launcher port allocation: dynamic free-port discovery

**Chosen:** `free-xats-opencode` finds an idle port using a small Node/Bun one-liner (`node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'`), then exports `OPENCODE_XATS_BASE_URL=http://127.0.0.1:<port>` and launches opencode with `--port <port>`.

**Rationale:** per user direction (decision 1 in explore). Dynamic allocation supports multiple concurrent opencode instances without port conflicts; the env var carries the chosen port into the agent so no fixed-value coupling is needed.

**Alternative considered:** fixed port (e.g., 18888). Rejected per user direction: multi-instance conflict.

### D7. Delete the 2026-04-30 archive entry

**Chosen:** remove `openspec/changes/archive/2026-04-30-drop-opencode-server-transport/` (proposal.md, design.md, tasks.md, specs/).

**Rationale:** that change's design doc still asserts *"opencode's own runtime can't consistently assert it is opencode"* as an architectural constraint. With the launcher-injected env approach, that constraint no longer holds. Leaving the archive in place would mislead future readers (and future us) into thinking the HTTP transport is fundamentally infeasible. The new `opencode-server-transport` spec's "Why this works now" scenario explicitly references and supersedes the old post-mortem.

**Alternative considered:** keep archive, add a forward-pointer comment. Rejected per user direction (decision 3 in explore): clean break, the new spec carries its own rationale.

## Risks / Trade-offs

- **[Risk] opencode changes its HTTP API surface.** `prompt_async` and `/session` are stable as of 1.17.7 (verified against the binary's OpenAPI spec embedded in `/doc`). Future breaking changes would surface as `opencode_inject_failed` at poke time. → **Mitigation:** the dispatcher maps HTTP failures to machine-readable errors; operator can diagnose via the documented curl equivalents.
- **[Risk] `time_updated` heuristic picks wrong session.** If a background session somehow has a more recent `time_updated` than the registering agent's session (e.g., a subagent fork updated first), the daemon binds the wrong `session_id` and pokes go to a dead session. → **Mitigation:** the registering agent's session is by definition the most recently active one at register time (the agent just called a Bash tool). Forked subagents have their own `parent_id` and are typically created later. If misbinding surfaces in practice, add an optional explicit `session_id` parameter (already in the schema) and document the override.
- **[Risk] User launches opencode via plain `opencode` instead of `free-xats-opencode`.** No env var, no DETECTION match, agent falls through to `agent_type='custom'` + tmux. Silent regression to the old path. → **Mitigation:** README + zh-CN README make the wrapper the documented entry point; `register_agent` description's DETECTION step 0 makes the env-var check the agent's first move.
- **[Risk] opencode TUI server bound to a non-loopback hostname.** The launcher hardcodes `--hostname 127.0.0.1`. A user overriding `--hostname 0.0.0.0` exposes an unauthenticated prompt_async endpoint. → **Mitigation:** launcher's hardcoded `127.0.0.1` is the default; users who override also need to set `OPENCODE_SERVER_PASSWORD` and `auth_token_ref`, which the spec documents.
- **[Trade-off] No tmux fallback means a crashed opencode server yields un-delivered pokes.** This is intentional and symmetric with codex-appserver; the alternative (silent tmux fallback) masks the failure and risks double-input on recovery.
- **[Trade-off] Session-switch requires re-register.** Unusual workflow per user. Not worth the complexity of poke-time session re-resolution.

## Migration Plan

Single-operator, pre-v1, no compat layer:

1. `git pull` post-change, `pnpm build`.
2. `./stop-server.sh && ./start-server.sh` to reload daemon.
3. Install `free-xats-opencode` zsh function in `~/.zshrc` (documented snippet).
4. Replace `opencode` invocation with `free-xats-opencode` (or keep plain `opencode` for the tmux fallback path — both work).
5. Inside opencode, register with the same prompt shape as before: `name`, `team`. The agent picks up `agent_type='opencode'` automatically from the env var.

No DB migration: `delivery_kind` already accepts arbitrary strings; the new `'opencode-server'` value is just new data.

## Open Questions

None. All three fork-in-the-road decisions were resolved during explore:
- agent_type enum: new `'opencode'` value (D2).
- session switching: not handled (Non-Goal).
- archive cleanup: delete outright (D7).
