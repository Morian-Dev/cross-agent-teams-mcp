## Context

The earlier `add-codex-pane-pre-register` change built the daemon-side pieces for auto-binding a codex agent's tmux pane at `register_agent` time via a launcher-seeded pre-reg table.  It did **not** update any tool-surface guidance, and it deliberately left the `codex-appserver` primary delivery channel alone because we thought codex did not expose `thread_id` to MCP tool subprocesses.

Today's session revealed two things:
1. codex 0.124.0 **does** export `CODEX_THREAD_ID` in the env of every MCP tool shell it spawns.  A codex agent can therefore discover its own thread id without any out-of-band mechanism.
2. Codex agents routinely hunt for `ui_pid` (via `$PPID` then manual `ps`) and pass it to `register_agent`.  Doing so **defeats the pre-reg auto-bind** we just shipped — when `ui_pid` is supplied, the daemon skips the pre-reg path.

Both are behavior / guidance problems, not daemon bugs.  `RegisterCodexSelfService` already knows how to bind a codex-appserver delivery given `thread_id + ws_url`.  We just need to put a proper entry point on it (mirroring `register_claude_self`) and update tool/server descriptions so codex LLMs pick the right path by default.

## Goals / Non-Goals

**Goals:**
- Give codex clients the same ergonomic "self register" entry point Claude Code has.
- Bake the `$CODEX_THREAD_ID` env into the codex agent's mental model via tool and server instruction text.
- Steer codex agents away from manual `ui_pid` discovery so the `add-codex-pane-pre-register` auto-bind actually fires.

**Non-Goals:**
- Auto-reading `$CODEX_THREAD_ID` on the daemon side.  The daemon is a long-lived HTTP server and does **not** inherit codex's per-tool env.  Only the LLM's tool shell has the env; only the LLM can pass the value.
- Changing `RegisterCodexSelfService`, delivery dispatch, or any existing code path.  This change is purely additive tool surface + instruction text.
- Supporting older codex versions that don't export `CODEX_THREAD_ID`.  Those agents continue to work through the `register_agent({client:"codex", ws_url})` → `thread_id_required` candidate-list fallback.

## Decisions

### D1: Wrap the existing service, don't duplicate the logic

**Choice**: `register_codex_self` is a zod-validated MCP tool that dispatches to the existing `executeRegister` helper with `client="codex"` locked.  Same path `register_agent` with `client=codex,thread_id,ws_url` already takes.  No new service class, no new connection logic.

**Rationale**: The whole point is to surface what's already there.  Duplicating the codex-appserver init/resume sequence would invite drift.

**Alternatives considered**:
- A standalone `RegisterCodexSelfTool` service that reimplements the ws init: rejected, redundant.
- Extending `RegisterCodexSelfService` with LLM-guidance fields: rejected, conflates service with UX.

### D2: Reject `ui_pid` / `tmux_pane_id` / `delivery` / `channel_session_id` at the schema level

**Choice**: The `register_codex_self` zod input schema is `strict()` and only includes `{name, model?, role?, team?, project_dir?, thread_id?, ws_url?, auth_token_ref?}`.  Passing `ui_pid` or any of the other excluded keys returns a zod validation error.

**Rationale**:
- Prevents the exact failure mode we saw today (codex agent defensively passing `ui_pid=42305`, which silently disables pre-reg auto-bind).  An early, loud validation error is better than a silent feature-off.
- Keeps the tool focused: identity + codex-appserver binding.  If a user genuinely needs tmux_pane_id / delivery overrides, that's what `register_agent` is for.

**Alternatives considered**:
- Accept `ui_pid` and warn in the response: rejected, agents ignore warnings.
- Silently drop unknown keys: rejected, hides bugs.

### D3: Default `ws_url` to `ws://127.0.0.1:8799`, with env override

**Choice**: When `ws_url` is omitted, `register_codex_self` falls back to `ws://127.0.0.1:8799` unless the daemon process env has `CROSS_AGENT_TEAMS_CODEX_WS_URL` set (in which case that wins).  This matches the existing `DEFAULT_CODEX_WS_URL` constant already used by `RegisterCodexSelfService`.

**Rationale**: The 8799 port is codex app-server's default listen port in the user's workflow.  Forcing the LLM to always pass `ws_url` is unnecessary ceremony.  Env override preserves the existing escape hatch for non-default ports.

### D4: Tool description and server instructions are where guidance lives

**Choice**: Codex-specific guidance lives in three places:
1. `register_codex_self` tool description: tells the LLM to read `$CODEX_THREAD_ID`, pass `project_dir`, and skip `ui_pid`.
2. `register_agent` tool description: adds a one-liner pointing codex callers at `register_codex_self` and warning against manual `ui_pid`.
3. Top-level MCP server instructions (the block set in `src/mcp/transport.ts` via `server.setInstructions`): adds a short codex section with the same substance.

**Rationale**: The same guidance appears in multiple surfaces because different LLM harnesses weight them differently.  MCP server instructions are loaded once at connect and anchor the agent's mental model; tool descriptions are consulted whenever the agent considers calling the tool.  Both need to agree.

**Alternatives considered**:
- Put guidance only in one place: rejected, too easy for LLMs to ignore a single mention.

### D5: Keep `register_agent` unchanged functionally; only its description text changes

**Choice**: No functional change to `register_agent`.  It still accepts `ui_pid`, still routes codex callers through the existing paths.  Only the description text adds codex-specific nudging.

**Rationale**:
- Backwards compatibility: existing scripts / launchers calling `register_agent` with `ui_pid` must keep working.
- Separation: if an advanced caller genuinely knows its `ui_pid` and wants to bypass pre-reg, they can still do so via `register_agent`.  The default codex agent follows `register_codex_self`.

### D6: No daemon-side env reading

**Choice**: The daemon does NOT try to read `CODEX_THREAD_ID` from its own `process.env`.

**Rationale**: The daemon is a long-lived Fastify HTTP server started once and reused across every codex session.  Its env is frozen at start.  `CODEX_THREAD_ID` only exists in the LLM's tool-shell env (set by codex for each tool invocation).  Attempting to "auto-read" it server-side would either always be empty or always be stale — both silently wrong.

## Risks / Trade-offs

- **[Future codex version removes `CODEX_THREAD_ID`]** If the codex team ever drops this env export, the tool description's guidance becomes a dead reference.  Pre-existing `thread_id_required` candidate-list fallback still works.  **Mitigation**: call it out in the tool description as "if CODEX_THREAD_ID is set"; when it's not, agents fall back to `register_agent({client:"codex", ws_url})` and pick from the candidate list.
- **[LLMs still pass `ui_pid` despite description]** Some harnesses aggressively "fill in" recognized argument shapes.  Strict schema rejection (D2) is the hard stop: agents that pass `ui_pid` to `register_codex_self` get a validation error, not a silent feature-off.  They'll correct on the next tool call.  **Mitigation**: covered by schema strictness.
- **[Agent confusion between register_agent and register_codex_self]** Two codex-capable entry points risks churn.  **Mitigation**: `register_agent` description actively points at `register_codex_self` for codex clients.  Same pattern already works between `register_agent` and `register_claude_self`.
- **[Server instructions grow unbounded]** Each new client kind wants its own block.  **Mitigation**: acceptable for now (we have 3 client kinds: codex, claude-code, opencode).  Revisit if instructions approach model-context problems.

## Migration Plan

1. Ship `register_codex_self` tool + updated descriptions + updated server instructions in a single release.
2. Existing `register_agent({client:"codex", thread_id, ws_url})` callers keep working; no breaking change.
3. Update `docs/launchers/free-xats-codex.md` is NOT required — the launcher doesn't touch register surface.  But the doc can mention "agents should call `register_codex_self` now" as an FYI follow-up.

No rollback drama: pure additive tool + description text.  If reverted, codex agents fall back to manual `register_agent`.

## Open Questions

- Should `register_codex_self` accept `tmux_pane_id` for advanced launcher scenarios (where the launcher explicitly picks a pane)?  **Current answer**: no, keep the tool minimal; power users use `register_agent`.
- Should we emit a one-line log line when codex agent tmux pane was bound via pre-reg (so users can verify the end-to-end flow)?  **Out of scope** here; track separately if observability becomes a pain.
