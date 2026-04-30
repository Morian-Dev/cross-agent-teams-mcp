## Context

The `cross-agent-teams-mcp` daemon currently exposes three MCP tools for self-registration:

```
register_agent           generic, accepts agent_type = "codex" | "claude-code" | "opencode" | "custom"
register_claude_self     shorthand for register_agent({ agent_type: "claude-code", model: <sniffed>, ... })
register_codex_self      shorthand for register_agent({ agent_type: "codex", model: "gpt", ws_url: "", ... })
```

All three converge on `executeRegister` in `src/mcp/tools.ts` (line 440). Routing is gated on the `agent_type` field, NOT on which tool name was invoked:

```
executeRegister(args)
  if args.agent_type === 'claude-code' && args.ui_pid && args.channel_session_id
    → consistency check via AutoBindChannelService.lookup
  if args.agent_type === 'codex' && args.delivery === undefined
                            && (thread_id|ws_url|auth_token_ref present)
    → registerCodexSelfSvc.register(...)         (codex-appserver handshake path)
  else
    → registerSvc.register(...)                  (generic path)
```

So `register_claude_self` and `register_codex_self` are pure dispatch shims. The two pieces of behavior they each contribute:

1. `register_claude_self` model fallback: `args.model ?? defaultClaudeSelfModel(getSessionClientInfo?.())`
2. `register_codex_self` ws_url fallback: `args.ws_url ?? ''` (forces codex-appserver path even when `thread_id` is omitted, so the daemon returns the `thread_id_required` candidate envelope rather than degrading to `delivery=none`)

Both can be moved into `executeRegister` keyed on `args.agent_type`.

The motivating failure: cursor (an editor with MCP capability) is neither codex nor Claude Code. When asked to register, an LLM running in cursor pattern-matches on the most descriptive tool name and picks `register_codex_self` or `register_claude_self`, polluting `agents.agent_type` with an incorrect kind. There is no in-band signal to tell the LLM "you are not Codex". A single `register_agent` tool with explicit `agent_type=` and a `custom` fallback removes the ambiguity.

## Goals / Non-Goals

**Goals:**
- Eliminate `register_claude_self` and `register_codex_self` from the MCP tool surface.
- Preserve all existing behavior reachable via `register_agent({ agent_type, ... })` with no daemon-protocol or storage change.
- Make agent-type detection mechanically executable in the `register_agent` tool description: list known kinds (`codex`, `claude-code`, `opencode`, `cursor`) with concrete env/PATH probes, plus the `custom + agent_type_name` fallback for everything else.
- Enforce `agent_type="codex"` → `thread_id` required at the schema layer (the no-`thread_id` case is the launcher pre-reg path, which uses `pre_register_codex_pane`, not self-register).
- Keep the codex-appserver handshake path intact via `RegisterCodexSelfService`, now invoked only through `executeRegister` for `register_agent({agent_type:'codex'})`.

**Non-Goals:**
- No deprecation window. The two tools are removed in one release (`0.4.0`).
- No support for the legacy tool names as aliases or 410-style stubs.
- No change to `pre_register_codex_pane`, `bind_channel`, `bind_runtime_identity`, or any non-register MCP tool.
- No change to the `agents` table schema or the on-wire registration protocol.
- No DB migration. The `agents.agent_type` column already exists and accepts the four enum values.

## Decisions

### D1: Delete the two MCP tool registrations entirely (vs. keep as aliases or hidden)

**Decision**: Delete the `server.registerTool('register_claude_self', ...)` and `server.registerTool('register_codex_self', ...)` blocks in `src/mcp/tools.ts`. The tools disappear from `tools/list` and become uncallable.

**Rationale**: MCP has no first-class "hidden tool" concept. Keeping the tools as aliases that forward to `register_agent` does not solve the original problem (LLMs would still see them in `tools/list` and pattern-match). A clean break in `0.4.0` is acceptable because (a) this is a local-only service per MEMORY notes, and (b) the published version line is currently `0.3.x` daemon-only, so a minor bump under 0.x already signals breakage in this codebase.

**Alternatives considered**:
- "Soft deprecate first": leave the tools, add a `deprecated: true` MCP annotation, remove later. Rejected — the harm (misclassification) keeps happening during the deprecation window, and the user explicitly said no deprecation window.
- "Hide from `tools/list` but keep server-side handler": MCP spec does not support this. Rejected.

### D2: Move model and ws_url defaults into `executeRegister`, keyed on `agent_type`

**Decision**: Inside `executeRegister`, before any branching, apply:

```typescript
if (args.agent_type === 'claude-code' && args.model === undefined) {
  args.model = defaultClaudeSelfModel(getSessionClientInfo?.())
}
if (args.agent_type === 'codex' && args.ws_url === undefined) {
  args.ws_url = ''
}
if (args.agent_type === 'codex' && args.model === undefined) {
  args.model = 'gpt'
}
```

The `defaultClaudeSelfModel` helper stays where it is (line 146 in `src/mcp/tools.ts`); only its call site moves.

**Rationale**: Defaults belong in one path. Putting them in `executeRegister` keeps the schema-validation surface honest (`model` stays `optional`) while preserving the existing behavior reachable through both deleted tools.

**Alternatives considered**:
- Push defaults into the Zod schema's `.transform`. Rejected — `getSessionClientInfo()` is a runtime concern, not a parse-time one.
- Make `model` required in `register_agent`. Rejected — would break Claude Code callers that legitimately omit it.

### D3: Schema refinement for `agent_type="codex"` → `thread_id` required

**Decision**: Extend `registerAgentArgsSchema` with a `superRefine` step:

```
if (data.agent_type === 'codex' && (data.thread_id === undefined || data.thread_id === '')) {
  ctx.addIssue({
    path: ['thread_id'],
    message: 'thread_id is required when agent_type="codex". '
             + 'If you are a launcher pre-registering a codex pane, use pre_register_codex_pane instead.'
  })
}
```

**Rationale**: Without `thread_id`, the codex-appserver handshake cannot resolve a real thread, and the response is the `thread_id_required` envelope. That envelope was useful as a discovery aid for `register_codex_self`, but on the unified `register_agent` surface it confuses callers — they typed an explicit `agent_type` and expect a real registration. The launcher pre-reg flow has its own dedicated tool (`pre_register_codex_pane`).

**Alternatives considered**:
- Keep the `thread_id_required` candidate envelope behavior. Rejected — it conflates self-register with discovery and reproduces the pattern-match-on-tool-name problem at the response level.
- Validate at the service layer instead of the schema. Rejected — schema-level rejection gives the LLM a clear error before the call hits any side-effect path.

### D4: DETECTION block in the `register_agent` tool description

**Decision**: Add a top-of-description block listing four known agent types with concrete probes:

```
DETECTION (run these BEFORE choosing agent_type=, in order; first match wins):

  1. shell `printenv CODEX_THREAD_ID` → non-empty?
       → agent_type="codex"; pass that value as thread_id (REQUIRED for codex)
       → do NOT pass ui_pid (launcher pre-reg handles pane binding)

  2. shell `printenv CLAUDECODE` OR `printenv CLAUDE_CODE_ENTRYPOINT` → non-empty?
       → agent_type="claude-code"; pass $PPID as ui_pid for channel auto-bind

  3. shell `command -v opencode` → exits 0?
       → agent_type="opencode"

  4. shell `printenv CURSOR_TRACE_ID` → non-empty?
       OR parent process name contains "Cursor Helper"
       → agent_type="custom"; agent_type_name="cursor"

  5. None of the above
       → agent_type="custom"; agent_type_name=<the harness name you are running under>
```

**Rationale**: The previous tool descriptions said "Codex clients SHOULD prefer X" — but the LLM has to FIRST know it is a codex client. Mechanical probes turn identity from a self-knowledge problem into a shell-out problem. cursor does not have a stable env var as widely documented as `CODEX_THREAD_ID` or `CLAUDECODE`, so it falls under `agent_type="custom"` with `agent_type_name="cursor"` — recorded explicitly as case 4 so the LLM does not have to guess.

**Alternatives considered**:
- A separate `detect_agent_type` MCP tool. Rejected — adds another tool the LLM has to discover first; the description-block approach front-loads the work into the tool the LLM is already calling.
- Push detection into a host-side launcher. Rejected — many MCP clients (cursor included) do not have a launcher hook to do this, and the failure mode the change addresses happens at the agent level, not the launcher level.

### D5: Treat `RegisterCodexSelfService` as a backend, not a tool

**Decision**: Keep `src/mcp/register-codex-self.ts` and the `registerCodexSelfSvc` instance unchanged. `executeRegister` continues to invoke `registerCodexSelfSvc.register(...)` for the `agent_type="codex" + has codex transport fields` branch. The class name is now slightly misleading (no longer tied to a `register_codex_self` tool), but renaming is out of scope — keep the rename as a separate cosmetic change if desired.

**Rationale**: The class owns the codex-appserver `initialize` + `thread/resume` handshake plus ws_url defaulting. That logic is still needed for `register_agent({ agent_type: "codex", thread_id, ... })`. Deleting it would lose real behavior; only the MCP-tool wrapper around it goes.

### D6: Test rewrite vs. delete

**Decision** per test file:

| Test file | Action |
|---|---|
| `tests/register-codex-self-tool.test.ts` | DELETE — verifies the MCP tool surface that is being removed. |
| `tests/register-claude-self-csid-uipid-mismatch.test.ts` | REWRITE — repoint at `register_agent({agent_type:'claude-code', ui_pid, channel_session_id})`, same assertion. |
| `tests/register-codex-self.test.ts` | KEEP — exercises `RegisterCodexSelfService` directly, not the deleted MCP wrapper. |
| `tests/register-agent-codex-pre-reg.test.ts` | KEEP — exercises pre-reg flow, unaffected. |
| `tests/register-agent-client-routing.test.ts` | KEEP — already tests `register_agent` routing. |
| Other `register-agent-*.test.ts` | KEEP unless they hardcode the deleted tool names. |

**Rationale**: Delete what only verifies the deprecated surface; rewrite anything whose underlying behavior should still be guaranteed (csid/ui_pid mismatch detection lives in `executeRegister` and survives the wrapper deletion).

### D7: Update the MCP server-instructions string in `src/mcp/transport.ts`

**Decision**: `src/mcp/transport.ts` line 38-39 is the MCP `serverInfo.instructions` string returned during `initialize`. It currently mentions both `register_claude_self` and `register_codex_self`. Rewrite to recommend `register_agent` only, mirroring the DETECTION rules in D4 (in condensed form, since the full detection block lives in the tool description).

**Rationale**: Some MCP clients surface `instructions` to the LLM as system context. If it still says "prefer `register_codex_self`", LLMs will still try.

## Risks / Trade-offs

- **[Risk] Existing MCP clients call deleted tool names** → Mitigation: 0.4.0 minor bump, README rewrite, `CHANGELOG.md` BREAKING entry. Per MEMORY this is a local-only npm line; impact is contained.
- **[Risk] cursor/opencode detection probes are wrong or fragile** → Mitigation: each probe is documented as "best-effort"; the rule is "first match wins, fall through to `custom + agent_type_name`". A wrong probe degrades to a `custom` registration with the right `agent_type_name`, which is still better than today's `claude-code` or `codex` misclassification.
- **[Risk] `defaultClaudeSelfModel` was the only call site of `getSessionClientInfo()` outside generic register_agent paths** → Mitigation: grep before removal; if it stays in `executeRegister` it remains the only call site, no helper deletion needed beyond inlining.
- **[Trade-off] `RegisterCodexSelfService` name is now misleading** → Accept; rename is a cosmetic follow-up, not part of this change.
- **[Trade-off] Schema-level `agent_type="codex"` → `thread_id` required is stricter than current behavior** → Accept; the `thread_id_required` envelope was a discovery affordance specific to the deleted tool. Pre-reg callers go through `pre_register_codex_pane`, which is unchanged.

## Migration Plan

1. Bump `package.json` version to `0.4.0`.
2. Add `CHANGELOG.md` entry (or equivalent) noting the breaking change.
3. Delete the two `server.registerTool` blocks; move defaults + add DETECTION + add schema refinement in one PR.
4. Rewrite or delete affected tests in the same PR; CI must stay green.
5. Rewrite `README.md`, `README.zh-CN.md`, and `src/mcp/transport.ts` instructions string in the same PR.
6. Publish `0.4.0` via the existing GitHub Actions OIDC pipeline (push to `release` branch).

**Rollback**: revert the PR; the deleted tool blocks come back unchanged because the underlying services were never modified.

## Open Questions

- Confirm `CURSOR_TRACE_ID` is the right cursor probe. If a more reliable signal exists (e.g. a `CURSOR_*` env var that is ALWAYS set, not just during traced runs), prefer that. If no reliable env signal exists, keep "parent process name contains 'Cursor Helper'" as a fallback or drop cursor from the named-detection list and let it land in case 5 (`custom + agent_type_name="cursor"` chosen by the LLM after self-identification).
- Should the DETECTION block also list `agent_type_name="cursor"` as an example for case 5 generic clients, or only in case 4? (Resolution: list it in case 4 explicitly, since the user requested cursor be a known kind.)
