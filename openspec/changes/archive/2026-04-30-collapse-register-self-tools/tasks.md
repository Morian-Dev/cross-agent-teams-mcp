## 1. Schema and tool description (src/mcp/tools.ts)

- [x] 1.1 Add `superRefine` to `registerAgentArgsSchema`: reject when `agent_type === 'codex'` and (`thread_id` is undefined OR empty string), with error message naming `thread_id` and pointing launcher pre-reg callers at `pre_register_codex_pane`.
- [x] 1.2 Extend the `register_agent` tool description with the DETECTION block: 5 ordered probes covering codex (`CODEX_THREAD_ID`), claude-code (`CLAUDECODE` / `CLAUDE_CODE_ENTRYPOINT`), opencode (`command -v opencode`), cursor (`CURSOR_TRACE_ID`), and the `agent_type="custom"` + `agent_type_name=<harness>` fallback. Verify every literal substring required by the agent-registry "register_agent tool description contains DETECTION block" requirement is present.
- [x] 1.3 Remove all clauses in the `register_agent` description that reference `register_claude_self` or `register_codex_self` (lines around tools.ts:656-660).

## 2. Move defaults into executeRegister (src/mcp/tools.ts)

- [x] 2.1 Inside `executeRegister`, before the `agent_type === 'claude-code'` consistency check, apply: if `args.agent_type === 'claude-code' && args.model === undefined` → `args.model = defaultClaudeSelfModel(getSessionClientInfo?.())`.
- [x] 2.2 Apply: if `args.agent_type === 'codex' && args.ws_url === undefined` → `args.ws_url = ''`.
- [x] 2.3 Apply: if `args.agent_type === 'codex' && args.model === undefined` → `args.model = 'gpt'`.
- [x] 2.4 Verify the existing branching at tools.ts:496-510 still routes `agent_type='codex' + has codex transport fields` calls through `registerCodexSelfSvc.register(...)` — no change needed, just confirm.

## 3. Delete MCP tool registrations (src/mcp/tools.ts)

- [x] 3.1 Delete the entire `server.registerTool('register_claude_self', ...)` block (currently around tools.ts:688-725).
- [x] 3.2 Delete the entire `server.registerTool('register_codex_self', ...)` block (currently around tools.ts:727-767).
- [x] 3.3 Delete the `registerClaudeSelfInputSchema` and `registerCodexSelfInputSchema` definitions if they are no longer referenced elsewhere.
- [x] 3.4 If `defaultClaudeSelfModel` is now only called from inside `executeRegister`, leave it where it is (move only if doing so improves locality; deletion is not required).
- [x] 3.5 Confirm `registerCodexSelfSvc` instance and `RegisterCodexSelfService` import remain — they back the `register_agent({agent_type:'codex'})` path inside `executeRegister`.

## 4. Update MCP server instructions (src/mcp/transport.ts)

- [x] 4.1 Rewrite the `serverInfo.instructions` string at transport.ts:38-39 to drop `register_claude_self` and `register_codex_self` references. Replace with `register_agent`-only guidance covering: agent types, `CODEX_THREAD_ID` for codex, `$PPID` as `ui_pid` for claude-code, `agent_type="custom" + agent_type_name` fallback. Preserve the existing `xats` abbreviation and `project_dir` team-default convention substrings.
- [x] 4.2 Verify the literal substrings required by `agent-registry`'s "Top-level MCP server instructions describe register_agent with agent_type= detection guidance" requirement are present (`register_agent`, `CODEX_THREAD_ID`, `agent_type="custom"`, `agent_type_name`).
- [x] 4.3 Verify the literal substrings required by `mcp-transport`'s instructions requirement are still present (`xats`, `cross-agent-teams`, `project_dir`).

## 5. Tests: delete or rewrite

- [x] 5.1 Delete `tests/register-codex-self-tool.test.ts` (verifies the MCP tool surface that no longer exists).
- [x] 5.2 Rewrite `tests/register-claude-self-csid-uipid-mismatch.test.ts` to call `register_agent({agent_type:'claude-code', ui_pid, channel_session_id})` instead of `register_claude_self`, asserting the same `channel_session_id_ui_pid_mismatch` error envelope. (Resolved: deleted as redundant with existing `tests/register-agent-claude-code-csid-uipid-mismatch.test.ts` which already covers all six scenarios on the `register_agent` surface.)
- [x] 5.3 Audit `tests/register-claude-self-team-default.test.ts` (or equivalent) and rewrite to call `register_agent({agent_type:'claude-code', project_dir, ...})`, or delete if redundant with existing `register-agent-*` team-default tests. (Resolved: `register-claude-self-tool.test.ts` and `register-claude-self-auto-bind.test.ts` deleted; team-default coverage already exists in `register-agent-name-required.test.ts` and `register-agent-service.test.ts`.)
- [x] 5.4 Keep `tests/register-codex-self.test.ts` unchanged — it exercises `RegisterCodexSelfService` directly, not the deleted MCP wrapper.
- [x] 5.5 Keep all `tests/register-agent-*.test.ts` files unless they reference the deleted tool names; audit each by `grep -l "register_claude_self\|register_codex_self" tests/`.
- [x] 5.6 Add new test: `register_agent({agent_type:'codex'})` without `thread_id` is rejected by Zod with an error citing `thread_id` and `pre_register_codex_pane`.
- [x] 5.7 Add new test: `tools/list` does NOT contain `register_claude_self` or `register_codex_self` entries.
- [x] 5.8 Add new test: `register_agent` description contains all DETECTION-block literal substrings (`CODEX_THREAD_ID`, `CLAUDECODE` or `CLAUDE_CODE_ENTRYPOINT`, `command -v opencode`, `CURSOR_TRACE_ID`, `agent_type="custom"` + `agent_type_name`).
- [x] 5.9 Add new test: MCP `instructions` string contains `register_agent` and `CODEX_THREAD_ID`, and does NOT contain `register_claude_self` or `register_codex_self`.

## 6. Documentation

- [x] 6.1 Update `README.md`: remove all `register_claude_self` / `register_codex_self` recommendations. Add a `register_agent({agent_type, ...})` example block with the DETECTION decision tree (codex / claude-code / opencode / custom).
- [x] 6.2 Update `README.zh-CN.md` symmetrically (keep wording aligned with `README.md`).
- [x] 6.3 Search `docs/` for any remaining mentions of the deleted tools and update.
- [x] 6.4 Add a `CHANGELOG.md` entry (or equivalent) under `0.4.0` noting the BREAKING removal.

## 7. Version bump and validation

- [x] 7.1 Bump `package.json` `version` to `0.4.0`.
- [x] 7.2 Run `npm run build` and confirm zero TypeScript errors.
- [x] 7.3 Run the full test suite (`npm test` or equivalent) and confirm all green. (525/526 pass; the single failure is the pre-existing `tests/proxy-reconnect.test.ts` which fails on HEAD too — verified via `git stash && npx vitest run tests/proxy-reconnect.test.ts`.)
- [x] 7.4 Run `openspec validate collapse-register-self-tools --strict` and confirm passes.
- [x] 7.5 Manual smoke test: start the daemon, connect an MCP client, run `tools/list` — confirm `register_claude_self` and `register_codex_self` are absent and `register_agent` description shows DETECTION block. (Covered by automated tests in `tests/register-agent-collapse-self-tools.test.ts`: "tools/list does NOT contain register_claude_self or register_codex_self" and "register_agent description contains DETECTION block literal substrings".)

## 8. Field-feedback amendment: drop opencode active probe + make model truly optional

- [x] 8.1 Drop `command -v opencode` probe from the DETECTION block in `src/mcp/tools.ts` (renumber: 1 codex / 2 claude-code / 3 custom fallback).  Field test: cursor (which is neither codex nor claude-code, but installed opencode locally) misclassified itself as `agent_type='opencode'` because the binary was on PATH.  Replace the active probe with an explicit anti-pattern warning ("do NOT guess from system-wide signals like 'binary X exists on PATH'").  Move `CURSOR_TRACE_ID` into the custom-fallback case as an in-line example for choosing `agent_type_name='cursor'` rather than as a separate active probe.
- [x] 8.2 Drop the Zod schema rejection at `executeRegister`'s call-site that required `model` for non-claude / non-codex agent types.  Drop the runtime guard `if (args.model === undefined) return { error: 'model_required' }` in `executeRegister`.
- [x] 8.3 Widen `RegisterInput['model']` from `string` to `string | undefined` in both `src/mcp/register-agent.ts` and `src/storage/agents-repo.ts`; bind `input.model ?? null` in the SQLite INSERT so omitted `model` stores SQL NULL.
- [x] 8.4 Add a sentence to the `register_agent` description stating `model` is OPTIONAL for any agent type.
- [x] 8.5 Update the MCP `serverInfo.instructions` string in `src/mcp/transport.ts` to (a) drop the "Known values" enumeration that included `opencode`, (b) replace the unknown-harness clause with one covering "ANY other harness (cursor, opencode, an editor extension, ...)", (c) add the same anti-pattern warning, (d) state that `model` is OPTIONAL.
- [x] 8.6 Update `tests/register-agent-collapse-self-tools.test.ts`: remove the `expect(d).toContain('command -v opencode')` and `CURSOR_TRACE_ID`-as-probe assertions; add a positive `not.toContain('command -v opencode')` assertion; add a new test case "register_agent({agent_type:'custom'}) without model succeeds and stores NULL".
- [x] 8.7 Update `README.md` and `README.zh-CN.md` to drop probes 3-4 from the DETECTION decision tree, fold cursor into the custom fallback as an example, and remove the "model required for non-claude/non-codex" line.  Note that `agent_type="opencode"` remains a valid enum value for opencode-aware launchers but is no longer promoted by any probe.
- [x] 8.8 Update `docs/configs/claude-code.md` to drop the opencode example from the "matching agent_type to ui_pid runtime" guidance.
- [x] 8.9 Update `CHANGELOG.md` 0.4.0 BREAKING entry to reflect the simplified DETECTION block and the model-optional widening.
- [x] 8.10 Run `npx tsc --noEmit` (clean), `npx vitest run tests/register-agent-collapse-self-tools.test.ts` (6/6 pass), and `openspec validate collapse-register-self-tools --strict` (pass).
- [x] 8.11 Live verify against the local 0.4.0 daemon: `tools/list` shows `register_agent` description with no `command -v opencode`, with the anti-pattern warning, and with `OPTIONAL` paired with `model`.
