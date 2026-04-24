## 1. Schema

- [x] 1.1 Add `codex_pane_pre_registrations` table to the DDL array in `src/storage/schema.ts` with columns `pane_id TEXT PRIMARY KEY`, `xats_agent_id TEXT NOT NULL`, `expires_at TEXT NOT NULL`
- [x] 1.2 Confirm the existing `applySchema` + `CREATE TABLE IF NOT EXISTS` pattern makes the migration a no-op on fresh and existing dbs; no separate `migrateXxx` helper is needed

## 2. Repository + service

- [x] 2.1 Create `src/mcp/codex-pane-pre-register-repo.ts` exporting `CodexPanePreRegRepo` with `upsert({pane_id, xats_agent_id, expires_at})`, `listUnexpired(now: string)`, `takeByPaneId(pane_id)` (DELETE ... RETURNING), and `deleteExpired(now)` methods
- [x] 2.2 Create `src/mcp/pre-register-codex-pane.ts` exporting `PreRegisterCodexPaneService` with `register({pane_id, xats_agent_id, ttl_seconds?})` that clamps `ttl_seconds` to `[1, 600]` (default 120), computes `expires_at`, calls `deleteExpired` + `upsert`, and returns `{ ok: true, expires_at }`
- [x] 2.3 Define strict zod input schema for the service (non-empty pane_id starting with `%`, non-empty xats_agent_id, optional positive-integer ttl_seconds), returning `{ error: "invalid_arguments", detail }` on failure

## 3. MCP tool registration

- [x] 3.1 Add the `pre_register_codex_pane` tool in `src/mcp/tools.ts` wired to `PreRegisterCodexPaneService`, with a description that cites this change's capability ("launcher claims a tmux pane before starting codex")
- [x] 3.2 Ensure the tool is callable without requiring a prior `register_agent` call (launcher has no agent identity yet); confirm no `requireAgent()` gate is applied

## 4. register_agent auto-bind via pre-reg

- [x] 4.1 In `src/mcp/tools.ts`, extend `autoBindRuntimeIdentity` (or add a sibling helper) that runs BEFORE the existing `detect_tmux_pane({agent})` fallback when `client="codex"` and `ui_pid` is undefined
- [x] 4.2 Implementation steps inside the helper:
  - Call `CodexPanePreRegRepo.listUnexpired(now)` (also GCs expired rows)
  - For each pending row, call `tmux list-panes` (reuse `detectTmuxPane` internals) to find the pane record for `pane_id`; skip if pane missing
  - Resolve pane's tty, then `ps -t <tty>` to get process argv list; keep rows where any process is a `codex --remote` with argv containing the literal substring `xats.agent_id="<stored_uuid>"`
  - If exactly one row passes all checks, extract that process's pid as `ui_pid`, call existing `bindRuntimeIdentitySvc.bind({callerAgentId, agent:"codex", ui_pid})`, and on success call `CodexPanePreRegRepo.takeByPaneId(pane_id)` to consume the row
- [x] 4.3 Wrap the whole helper in a try/catch that returns `false` on any error; never propagate as a register failure
- [x] 4.4 If the helper returns true, skip the `detectTmuxPane` fallback and the no-pane hint (auto-bind succeeded)
- [x] 4.5 If the helper returns false, preserve today's behavior: call the existing `detectTmuxPane` fallback, then emit the no-pane hint when that also fails to converge

## 5. CLI subcommand

- [x] 5.1 Refactor `src/cli.ts` main dispatcher to handle multiple subcommands (`daemon`, `pre-register-codex-pane`); keep the existing `daemon` behavior intact
- [x] 5.2 Add `pre-register-codex-pane` subcommand parsing `--pane`, `--agent-id`, `--ttl` (optional), `--port` (optional, default match daemon's), `--token` (optional, honors existing auth hook), printing a machine-friendly one-line success or error to stdout
- [x] 5.3 Implementation opens a short-lived MCP stdio-over-HTTP (or websocket, whichever the daemon currently uses for MCP mount) client, calls `pre_register_codex_pane` with the supplied args, and exits with code 0 on success / non-zero on error

## 6. Launcher + docs

- [x] 6.1 Add `docs/launchers/free-xats-codex.md` documenting the updated zsh function: `unalias` guard, generate UUID, invoke `cross-agent-teams-mcp pre-register-codex-pane --pane "$TMUX_PANE" --agent-id "$uuid"` when `$TMUX_PANE` is set, then `exec codex --remote ws://... -c xats.agent_id="\"$uuid\""`
- [x] 6.2 In the docs, note the non-tmux fall-through behavior and the "[xats] pre-register skipped: not in tmux" user-facing line
- [x] 6.3 Do NOT auto-modify `~/.zshrc` — the docs are the canonical artifact; users opt in

## 7. Tests

- [x] 7.1 Unit test `PreRegisterCodexPaneService` (happy path, ttl clamp, invalid inputs, upsert overwrite)
- [x] 7.2 Unit test the auto-bind helper with a mocked pane list / ps output: single match → bind + consume; zero matches → return false; multi-match → return false without consuming; argv UUID mismatch → return false without consuming; tmux unavailable → return false without throwing
- [x] 7.3 Integration test via the MCP tool boundary: call `pre_register_codex_pane`, then call `register_agent` (client=codex, no ui_pid), assert `tmux_pane_id` is populated and the pre-reg row is gone
- [x] 7.4 Integration test for the expiry path: insert a pre-reg with a TTL already in the past, call register, assert auto-bind did not fire and the expired row was GC'd
- [x] 7.5 Integration test for the failure path: force `bind_runtime_identity` to fail (e.g., invalid ui_pid mock), assert register still succeeds with the standard no-pane hint and the pre-reg row is left intact

## 8. Spec sync

- [x] 8.1 After green tests, run `openspec validate add-codex-pane-pre-register --strict` and fix any structural issues
- [x] 8.2 Do not archive in this pipeline run; archive is decided by the user via `/jt-os-implement --archive` later
