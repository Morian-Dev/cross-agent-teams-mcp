## 1. Remove opencode-only source modules

- [x] 1.1 Delete `src/mcp/opencode-transport.ts`
- [x] 1.2 Delete `src/mcp/register-opencode-self.ts`
- [x] 1.3 Delete `src/mcp/pre-register-opencode-pane.ts`
- [x] 1.4 Delete `src/mcp/auto-bind-opencode-pane.ts`
- [x] 1.5 Delete `src/mcp/bind-opencode-session.ts`
- [x] 1.6 Delete `src/storage/opencode-pane-prereg-repo.ts`

## 2. Remove opencode branches from shared code paths

- [x] 2.1 `src/mcp/transport-dispatch.ts`: remove `dispatchOpencode`, `tryOpencode`, the `opencode-server` branch in `DispatchResult`, and the opencode fallback in `resolveClient`; drop `sendOpencodePrompt` import and `opencodeDispatch` dep
- [x] 2.2 `src/mcp/poke.ts`: remove `opencode_base_url` / `opencode_session_id` from `TargetRow`, SELECT list, and the legacy `fanout == null` branch; remove the `'opencode-server'` response variant from `PokeResult`
- [x] 2.3 `src/mcp/send-message.ts`: remove `opencode_base_url` / `opencode_session_id` from the target row type and SELECT list
- [x] 2.4 `src/mcp/broadcast.ts` and `src/mcp/broadcast-to-role.ts`: remove opencode columns from SELECTs
- [x] 2.5 `src/mcp/agent-public-row.ts`: remove opencode fields from the public row shape and projection
- [x] 2.6 `src/mcp/tools.ts`: delete the `client === 'opencode' && (base_url | session_id)` validation branch; delete the registrations for `register_opencode_self`, `pre_register_opencode_pane`, `bind_opencode_session`; drop imports for deleted modules; remove the opencode description hint from `register_agent`'s description string
- [x] 2.7 `src/mcp/transport.ts`: delete the opencode paragraph from the MCP server `instructions` string (leave the xats abbreviation + team-default convention intact)

## 3. Drop schema artifacts

- [x] 3.1 `src/storage/schema.ts`: remove `opencode_base_url` and `opencode_session_id` from the fresh-database `CREATE TABLE agents` statement; remove the `CREATE TABLE opencode_pane_pre_registrations` block; remove the corresponding migration `ALTER TABLE` / `CREATE TABLE IF NOT EXISTS` paths
- [x] 3.2 `src/storage/agents-repo.ts`: remove opencode columns from every SELECT, INSERT, UPDATE, and row-shape typing; remove any opencode-specific methods

## 4. Preserve opencode as a label

- [x] 4.1 Confirm `src/lib/client-kind.ts` still exports `'opencode'` as a valid `ClientKind` (no change expected)
- [x] 4.2 Confirm `src/daemon/tmux-pane-detect.ts` and `src/daemon/runtime-identity.ts` still contain the `/(^|[\s/])opencode([\s]|$)/i` regex and the `'opencode'` entry in their agent-kind switches (no change expected)
- [x] 4.3 Verify `register_agent` and `detect_tmux_pane` zod schemas still accept `client/agent: 'opencode'` (no change expected)

## 5. Delete launcher and standalone scripts

- [x] 5.1 Delete `launch-opencode.sh`
- [x] 5.2 Delete `test-opencode-poke.mjs`
- [x] 5.3 Grep for any remaining references to either filename inside the repo and remove them

## 6. Delete opencode-only tests

- [x] 6.1 Delete `tests/opencode-pane-prereg-repo.test.ts`
- [x] 6.2 Delete `tests/opencode-schema-binding.test.ts`
- [x] 6.3 Delete `tests/opencode-transport-dispatch.test.ts`
- [x] 6.4 Delete `tests/opencode-transport-http.test.ts`
- [x] 6.5 Delete `tests/poke-opencode-no-fanout.test.ts`
- [x] 6.6 Delete `tests/pre-register-opencode-pane-cli.test.ts`
- [x] 6.7 Delete `tests/pre-register-opencode-pane-service.test.ts`
- [x] 6.8 Delete `tests/register-agent-opencode-pre-reg.test.ts`
- [x] 6.9 Delete `tests/register-opencode-self-tool.test.ts`
- [x] 6.10 Delete `tests/launch-opencode.test.ts`

## 7. Update cross-cutting tests

- [x] 7.1 `tests/poke-*.test.ts`: remove opencode fixtures / assertions; delete scenarios that asserted `transport_used === 'opencode-server'`
- [x] 7.2 `tests/broadcast*.test.ts` and `tests/broadcast-to-role.test.ts`: drop opencode target rows; update any broadcast delivery assertions that referenced opencode transport
- [x] 7.3 `tests/send-message*.test.ts` and `tests/send-message-by-id*.test.ts`: drop opencode fixtures; ensure no test still selects `opencode_base_url` / `opencode_session_id`
- [x] 7.4 `tests/register-agent*.test.ts`: remove scenarios for `register_agent({client:'opencode', base_url, session_id})` and the `client === 'opencode'` metadata validation branch; keep scenarios that register `client:'opencode'` without base_url/session_id (label-only)
- [x] 7.5 `tests/agents-repo*.test.ts` and `tests/agents-schema.test.ts`: remove opencode column assertions (`PRAGMA table_info` should no longer list them)
- [x] 7.6 `tests/transport-dispatch*.test.ts`: delete opencode-specific dispatch cases
- [x] 7.7 `tests/list-agents*.test.ts`: drop opencode fields from expected response shapes
- [x] 7.8 Any other tests surfaced by `rg "opencode_base_url|opencode_session_id|register_opencode_self|bind_opencode_session|pre_register_opencode_pane|opencode-server|opencode-transport" tests/`: update to the post-change shape

## 8. Add post-change positive test

- [x] 8.1 Add `tests/register-agent-opencode-tmux.test.ts`: `register_agent({client:'opencode', ui_pid:<fake pid>, ...})` binds `tmux_pane_id` via the generic pid-based path and a subsequent `poke` from another agent returns `{ ok: true, transport_used: 'tmux-poke', pane_id, pane_tail_before, pane_tail_after }`. Use the same test harness style as existing pid-based binding tests (mock pid → tty → pane).

## 9. Documentation

- [x] 9.1 `README.md`: rewrite the opencode launcher section into a short "Using opencode with xats (tmux)" section that shows `tmux new-window; opencode; register_agent({client:'opencode', ui_pid:<opencode pid>, ...})`; remove references to `register_opencode_self`, `pre_register_opencode_pane`, `bind_opencode_session`, `launch-opencode.sh`, `free-xats-opencode`, `opencode-server` transport, and the `opencode_base_url` / `opencode_session_id` columns; update the `transport_used` enum to `claude-channel | tmux-poke | codex-appserver`
- [x] 9.2 `README.zh-CN.md`: mirror the same rewrite in 简体中文
- [x] 9.3 `docs/configs/opencode.md`: rewrite the entire page for the tmux-only path (retain only content that still applies: opencode MCP setup, tmux setup tips)
- [x] 9.4 Grep for any remaining mention of `opencode-server`, `register_opencode_self`, `pre_register_opencode_pane`, `bind_opencode_session`, `launch-opencode`, `opencode_base_url`, `opencode_session_id`, `opencode_pane_pre_registrations` inside `README.md`, `README.zh-CN.md`, `AGENTS.md`, `docs/`, and remove / update any remaining references
- [x] 9.5 Leave `discuss/` and `openspec/changes/archive/` untouched (historical record)

## 10. Build, typecheck, and run tests

- [x] 10.1 `pnpm install` (if needed) and `pnpm build` — confirm TypeScript compiles with zero errors (all opencode imports/types must have been cleaned up by 1.x / 2.x / 3.x)
- [x] 10.2 `pnpm test` — confirm all retained + new tests pass
- [x] 10.3 Run `openspec validate drop-opencode-server-transport --strict` and confirm it passes

## 11. Operator cutover note

- [x] 11.1 Write a short operator cutover checklist (could be a short block at the end of the README's opencode section, or in `docs/configs/opencode.md`): stop-server first (wipes data.db), rebuild, restart, then re-register opencode agents via the new path. Mention that any shell alias pointing at `launch-opencode.sh` must be removed.
