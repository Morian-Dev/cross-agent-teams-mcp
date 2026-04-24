## 1. Schema and storage

- [x] 1.1 Add `opencode_pane_pre_registrations` table to `src/storage/schema.ts` (columns: `pane_id PRIMARY KEY`, `base_url`, `session_id`, `expires_at`) alongside the existing `codex_pane_pre_registrations` table
- [x] 1.2 Add a repository module (`src/storage/opencode-pane-prereg-repo.ts`) with `put(row)`, `consume(pane_id, now)`, `purgeExpired(now)`, and `get(pane_id, now)` helpers, mirroring the codex-pre-reg repo if one exists, else following the same style
- [x] 1.3 Unit tests for the repo covering upsert-on-same-pane, expired row skip, purge-on-put, and consume-then-gone

## 2. `pre_register_opencode_pane` MCP tool

- [x] 2.1 Create `src/mcp/pre-register-opencode-pane.ts` with a service class that validates `pane_id`, `base_url` (loopback-only), `session_id`, and `ttl_seconds` (default 120, cap 600) then writes the row and opportunistically purges expired rows
- [x] 2.2 Register the tool in `src/mcp/tools.ts` with a strict zod schema and a description that explains the launcher handshake
- [x] 2.3 Unit tests for the service: happy path, missing pane_id, blank session_id, non-loopback base_url, ttl cap, overwrite-on-same-pane

## 3. `pre-register-opencode-pane` CLI subcommand

- [x] 3.1 Extend `src/cli.ts` with a `pre-register-opencode-pane` subcommand that mirrors the existing `pre-register-codex-pane` shape (`--pane`, `--base-url`, `--session-id`, optional `--ttl`, optional `--port`, optional `--token`)
- [x] 3.2 Emit JSON output on stdout for success and on stderr for failure, consistent with the codex CLI
- [x] 3.3 Smoke test: invoke the CLI against a running test daemon and verify the row lands in the pre-reg table

## 4. `register_opencode_self` MCP tool

- [x] 4.1 Create `src/mcp/register-opencode-self.ts` with strict zod schema (`name` required; optional `team`, `role`, `project_dir`, `model`; reject `ui_pid`, `channel_session_id`, `delivery`, `base_url`, `session_id`, `thread_id`, `claude_ui_pid`)
- [x] 4.2 Share the team default derivation with `register_agent` / `register_claude_self` / `register_codex_self` (`team` > `basename(project_dir)` > `'default'`)
- [x] 4.3 Default `model` to `'opencode'` when omitted
- [x] 4.4 After UPSERT, invoke the opencode pre-reg auto-bind path (see step 5) and surface any resulting metadata in the response envelope
- [x] 4.5 Register the tool in `src/mcp/tools.ts` with a description that lists the launcher pre-reg mechanism explicitly
- [x] 4.6 Unit tests: missing name rejected, extra keys rejected, model defaults, team derivation, project_dir-only derivation, explicit team wins

## 5. Pre-reg auto-bind path shared by both register paths

- [x] 5.1 Implement `autoBindOpencodeFromPreReg(callerAgentId, callerPane, now)` that purges expired rows, looks up `opencode_pane_pre_registrations` for the caller's pane, and if a live row is found updates the caller's agent row (`opencode_base_url`, `opencode_session_id`, `client='opencode'`) in the same transaction as the row deletion
- [x] 5.2 Wire the helper into `register_opencode_self` after the identity UPSERT
- [x] 5.3 Wire the helper into the `client === 'opencode'` branch of `executeRegister` (in `src/mcp/tools.ts`), BUT only when the caller did not supply both `base_url` and `session_id`.  When the caller supplied explicit metadata, preserve the current `bind_opencode_session` call and skip the pre-reg lookup
- [x] 5.4 Ensure the helper is a no-op (never throws) when the pane cannot be resolved or no row matches
- [x] 5.5 Unit tests: pane resolves + live row → fields populated + row deleted; pane resolves + no row → fields NULL; pane unresolved → fields NULL; expired row → fields NULL + row purged; second call without new pre-reg → fields revert to NULL

## 6. Tool description updates

- [x] 6.1 Update `register_agent` description in `src/mcp/tools.ts` to point opencode callers at `register_opencode_self` and to warn that explicit `base_url` / `session_id` disables pre-reg auto-bind
- [x] 6.2 Update the top-level MCP server instructions (the block emitted via `instructions` on initialize) to mention `register_opencode_self` alongside the existing claude / codex guidance
- [x] 6.3 Unit test that `tools/list` output for `register_opencode_self` contains the literal `pre_register_opencode_pane`
- [x] 6.4 Unit test that `tools/list` output for `register_agent` contains an opencode-launcher hint

## 7. Launcher script

- [x] 7.1 Add `launch-opencode.sh` at the repo root that: checks opencode server health, creates a session via POST `/session`, reads `$TMUX_PANE`, calls `cross-agent-teams-mcp pre-register-opencode-pane`, then execs opencode with the resolved attach argv (per design D3 / O1)
- [x] 7.2 If `$TMUX_PANE` is empty, exit with a clear error instructing the user to run inside tmux
- [x] 7.3 If opencode server is unhealthy, exit with a clear error instructing the user to run `./start-server.sh`
- [x] 7.4 Confirm the exact "attach to existing session" argv that opencode 1.14.19 accepts; if none is usable, fall back to plain `opencode` and print a one-line warning that only the daemon-side half is wired (open question O1)
- [x] 7.5 Make the script executable and add a usage comment at the top
- [ ] 7.6 Smoke test: run the launcher end-to-end against the existing `./start-server.sh` stack and verify a subsequent `list_agents` shows `opencode_base_url` / `opencode_session_id` populated

## 8. README and docs

- [x] 8.1 Rewrite the "Opencode Delivery" section in README.md so the launcher path is the first-class recipe and the manual `opencode serve` + `bind_opencode_session` flow is demoted to "advanced / custom" usage
- [x] 8.2 Add a "~/.zshrc alias" snippet showing `alias opencode='/path/to/launch-opencode.sh'` so users can opt in transparently
- [x] 8.3 Note the assumption that opencode CLI supports attach-to-session and document the limitation if O1 resolves negatively

## 9. Integration and end-to-end tests

- [x] 9.1 Add an integration test that: (a) writes a pre-reg row via the service, (b) calls `register_opencode_self` with a mocked caller pane matching the row, (c) asserts the agent row's opencode fields are populated, (d) asserts the row is gone
- [x] 9.2 Add an integration test for the unified path: same setup but via `register_agent({client:'opencode'})` without `base_url` / `session_id`
- [x] 9.3 Add a regression test that `register_agent({client:'opencode', base_url, session_id})` with explicit metadata still wins (pre-reg row untouched)
- [ ] 9.4 Extend the existing `test-opencode-poke.mjs` (or add a parallel `test-opencode-launcher.mjs`) that runs `launch-opencode.sh` in a scratch tmux pane and verifies the full poke → HTTP round trip

## 10. Openspec sync and release

- [x] 10.1 Run `openspec validate register-opencode-self --strict` and fix any issues
- [x] 10.2 Update `openspec/specs/agent-registry/spec.md` via `openspec-sync-specs` once implementation is green
