## 1. Refactor AutoBindChannelService to expose read-only lookup

- [x] 1.1 In `src/mcp/auto-bind-channel.ts`, add a public method `lookup(input: { ui_pid: number; team: string }): { ok: true; channel_session_id: string } | { ok: false; reason: 'no_proxy_row' | 'proxy_payload_corrupt' }` that runs the same SELECT as the existing `run(...)` and returns the proxy's csid without writing anything. Keep the `sink_not_live` reason check out of `lookup` — that concern belongs to the write path.
- [x] 1.2 Refactor the existing `run(...)` to call the new `lookup(...)` internally so the SELECT lives in exactly one place. Preserve the current `run(...)` return shape and the `sink_not_live` branch (check `fanout.has(csid)` after lookup).

## 2. Add csid-vs-ui_pid consistency check in tools.ts

- [x] 2.1 In `src/mcp/tools.ts`, inside the `register_agent({client:'claude-code'})` branch — between resolving the caller's effective team and calling `bindChannelSvc.bind` — when both `args.channel_session_id !== undefined` AND `args.ui_pid !== undefined`, call `autoBindChannelSvc.lookup({ ui_pid: args.ui_pid, team: res.team })`. If the lookup returns `ok:true` and its `channel_session_id` does NOT equal `args.channel_session_id`, return `{ error: 'channel_session_id_ui_pid_mismatch', detail: { ui_pid_matched_csid: <proxy csid>, supplied_csid: args.channel_session_id } }` BEFORE the UPSERT and SSE fanout attach. If `ok:false` or csids match, proceed unchanged.
- [x] 2.2 Mirror the same check in the `register_claude_self` tool handler so both entry points share identical behavior. If `register_claude_self` delegates into a shared helper, add the check in the helper; otherwise copy the guard inline and keep the two call sites in sync.
- [x] 2.3 Verify the check runs BEFORE `registerSvc.register(...)` / any UPSERT — a mismatch must not leave a partially-registered agent row behind. If the current code shape makes "before UPSERT" awkward, add a pre-check step at the very top of the register handler for `client === 'claude-code' && channel_session_id !== undefined && ui_pid !== undefined`.
- [x] 2.4 Ensure the check respects the caller's effective team. Derive the team via the same precedence as `register_agent` (`team` > `basename(project_dir)` > `'default'`) BEFORE invoking `lookup`, otherwise the proxy row filter silently falls through and loses the team scoping.

## 3. Rewrite the channel proxy startup hint

- [x] 3.1 In `plugins/cross-agent-teams-channel/src/cli.ts`, rewrite `buildStartupHint(csid)` so the returned `content` string:
  - Recommends `register_claude_self({name: "<agent-name>", ui_pid: $PPID})` as the PRIMARY path.
  - Mentions `register_agent({client:"claude-code", name, model, ui_pid: $PPID})` as the equivalent unified path.
  - Describes `bind_channel({channel_session_id: "${csid}"})` ONLY as the low-level rebind tool (for already-registered hosts that need to switch to a fresh csid).
  - Keeps the literal csid string visible in the content (needed for the `bind_channel` callsite).
  - Does NOT recommend passing `channel_session_id` as an argument to `register_claude_self` or `register_agent`.
  - Keeps the existing "do not use curl / external HTTP client" caveat verbatim.
- [x] 3.2 Update `plugins/cross-agent-teams-channel/tests/proxy-startup-notification.test.ts` so the assertions match the new recipe: content mentions `register_claude_self`, mentions `ui_pid`, mentions the literal csid, mentions `bind_channel`. Remove assertions that required the old csid-first recipe.

## 4. Update the register_agent / register_claude_self tool description strings

- [x] 4.1 In `src/mcp/tools.ts`, update the `register_agent` tool description paragraph that currently says `If channel_session_id is supplied explicitly, the explicit value wins and auto-bind is skipped` so it explicitly warns that supplying BOTH `ui_pid` AND `channel_session_id` now triggers a consistency check and will reject with `channel_session_id_ui_pid_mismatch` when the csid does not match the caller's live proxy.
- [x] 4.2 Update the `register_claude_self` tool description with the same caveat.

## 5. Unit tests for the consistency check

- [x] 5.1 Add `tests/register-claude-self-csid-uipid-mismatch.test.ts` covering: (a) mismatch rejects with the structured error, (b) matching csid proceeds and binds, (c) no live proxy row for ui_pid → proceeds to explicit-bind, (d) expired proxy row (outside 5-minute window) → proceeds to explicit-bind, (e) mismatch is scoped to team (different team → no rejection).
- [x] 5.2 Add `tests/register-agent-claude-code-csid-uipid-mismatch.test.ts` mirroring the same cases through the `register_agent({client:'claude-code'})` entry point, ensuring both tools enforce identical behavior.
- [x] 5.3 Cover the "both ui_pid and csid omitted" and "only csid supplied" paths to confirm the check does NOT fire when ui_pid is missing.

## 6. Wire-through tests

- [x] 6.1 Extend `tests/register-claude-self*.test.ts` (if any currently asserts csid+ui_pid co-supply succeeds silently): update to the new reject-on-mismatch behavior.
- [x] 6.2 Search for any cross-cutting test that passes both `channel_session_id` and `ui_pid` to `register_agent({client:'claude-code'})` and either uses the matching csid (OK) or needs updating (switch to ui_pid-only, or align csid to the fixture proxy).

## 7. Build and run full test suite

- [x] 7.1 `pnpm build` — confirm TypeScript compiles with zero errors.
- [x] 7.2 `pnpm test` — confirm all retained + new tests pass.
- [x] 7.3 `openspec validate fix-stale-channel-csid-bind-trap --strict` passes.

## 8. Manual smoke path

- [x] 8.1 Document a short manual verification in a comment on the final commit message or in a short throwaway note: build daemon, restart proxy, in a fresh Claude Code session: observe the startup hint recommends `ui_pid`, then call `register_claude_self({name:'opus', ui_pid:$PPID, channel_session_id:'<wrong csid>'})` and confirm the `channel_session_id_ui_pid_mismatch` error is returned (with no registration side-effect). Not a blocker for verify, just a smoke confidence path.

  Manual smoke (record for commit): after `pnpm build` + daemon restart, a fresh Claude Code session's startup hint should recommend `register_claude_self({name, ui_pid: $PPID})` (no csid). Calling `register_claude_self({name:'opus', ui_pid:$PPID, channel_session_id:'<wrong>'})` must return `{error:'channel_session_id_ui_pid_mismatch', detail:{ui_pid_matched_csid:<real csid>, supplied_csid:'<wrong>'}}` with zero agent rows written for `opus`. The automated suite (`tests/register-claude-self-csid-uipid-mismatch.test.ts` + `tests/register-agent-claude-code-csid-uipid-mismatch.test.ts`) already covers the identical predicates deterministically, so this smoke is a confidence check only.
