## Context

`cross-agent-teams-mcp` (xats) currently ships an `opencode-server` transport: a dedicated HTTP delivery path that calls `POST /session/{id}/prompt_async` on a loopback opencode server. The transport is wired through:

- A launcher script (`launch-opencode.sh`) that creates a server session via HTTP and pre-registers the launching tmux pane with the xats daemon.
- Three MCP tools: `pre_register_opencode_pane`, `register_opencode_self`, `bind_opencode_session`.
- Two agents-table columns (`opencode_base_url`, `opencode_session_id`) plus a dedicated `opencode_pane_pre_registrations` table.
- A `client === 'opencode'` branch in `transport-dispatch.ts` / `poke.ts`, paired with a `transport_used: 'opencode-server'` response variant.
- Twelve opencode-specific requirements in `agent-registry` and an entire `opencode-server-transport` capability (~90 lines).

Empirically this stack does not converge in real usage. The handshake depends on opencode reliably **self-identifying as opencode** inside its own MCP session so the daemon can correlate the TUI with the pre-registered pane. That premise does not hold: opencode's own runtime can't consistently assert it is opencode, so `register_opencode_self` (or `register_agent({client:'opencode'})` without explicit metadata) ends up without a pane to bind to, and the HTTP session the launcher created leaks. The fallback is tmux paste/Enter, which works — but is reached only after opencode's pre-reg path has already failed.

Meanwhile `src/daemon/tmux-pane-detect.ts` and `src/daemon/runtime-identity.ts` each carry a command-line regex `/(^|[\s/])opencode([\s]|$)/i` that identifies opencode panes from **outside** (by inspecting `ps` / tmux pane commands). This external detection is the robust signal; it does not depend on opencode's self-awareness.

## Goals / Non-Goals

**Goals:**
- Delete the `opencode-server` HTTP transport and the three opencode-specific MCP tools.
- Delete the launcher script and schema artifacts (columns + pre-reg table). No tombstone rows, no compat columns — the project is pre-v1 and `stop-server.sh` already wipes on-disk state.
- Keep opencode a first-class `ClientKind` label (`'opencode'`) and preserve the command-line regex in `tmux-pane-detect.ts` / `runtime-identity.ts` so external pane discovery for opencode still works.
- Fold opencode delivery into the same tmux paste/Enter path that `client:'custom'` already uses. Agents declared as `client:'opencode'` route through the generic pane-id tmux branch with zero opencode-specific code.
- Keep the mcp-transport Phase 0 three-client connectivity test as-is: opencode remains one of the three simulated MCP clients.

**Non-Goals:**
- No schema migration machinery for existing installs. `stop-server.sh` wipes `data.db`; re-starting the daemon creates a fresh schema without the dropped columns/table.
- No rebranding of `ClientKind` or `detect_tmux_pane`'s `agent` enum. `'opencode'` stays.
- No changes to `agent-delivery` or `mcp-transport` specs (see Context).
- No "soft deprecation" path. The three removed tools (`register_opencode_self`, `bind_opencode_session`, `pre_register_opencode_pane`) are deleted outright. Callers that invoke them receive MCP `tool_not_found`.
- No new docs for advanced opencode use-cases beyond "run opencode inside a tmux pane and call `register_agent({client:'opencode', ui_pid, ...})`".

## Decisions

### D1. Keep `ClientKind='opencode'` as a pure label

**Chosen:** retain `'opencode'` in `src/lib/client-kind.ts`, `tmux-pane-detect.ts`'s `DetectAgentKind`, and the `register_agent` / `detect_tmux_pane` zod enums.

**Rationale:** the label costs essentially nothing — it's a string — and carries real value for observability (`list_agents`, logs) and for the external pane detector, which uses it to select the opencode regex. Folding opencode into `'custom'` would force callers to pass `agent_matcher:'opencode'` or similar, pushing the same label elsewhere without simplification.

**Alternative considered:** collapse opencode into `'custom'` and have `tmux-pane-detect` dispatch by `client_name`. Rejected because it spreads the opencode name across two fields (`client` and `client_name`) instead of one, and because the mcp-transport Phase 0 spec explicitly references opencode as a simulated client kind — silently renaming it would ripple.

### D2. Route opencode poke through the generic tmux pane path

**Chosen:** in `transport-dispatch.ts`, remove `dispatchOpencode` and the `client === 'opencode'` branch entirely. `resolveClient` drops its opencode fallback (`target.opencode_base_url && target.opencode_session_id → 'opencode'`). Agents registered with `client:'opencode'` fall into `dispatchUnknown`, which already tries tmux when a pane is set.

**Rationale:** the only remaining requirement for opencode delivery is "paste into its tmux pane". `dispatchUnknown` already satisfies this for agents with no Claude channel or Codex thread. Collapsing opencode into this path removes the entire `tryOpencode` helper, the `OpencodeTransportResult` type, and the `'opencode-server'` response variant.

**Alternative considered:** add an explicit `dispatchOpencode` that immediately calls `dispatchTmux`. Rejected because it is pure ceremony — the common path already does exactly this, and a dedicated function would regrow the opencode branch.

### D3. Drop schema artifacts outright; no migration

**Chosen:** remove `opencode_base_url` / `opencode_session_id` from the agents table definition and remove the `opencode_pane_pre_registrations` table from the bootstrap + migration code. No ALTER TABLE DROP COLUMN (SQLite requires rebuild); no tombstone columns.

**Rationale:** the user instruction was "不用考虑兼容, 在 stop-server 的时候就删除历史了". This project is single-operator, pre-v1, and `stop-server.sh` already removes `data.db` on shutdown. A migration path would be waste.

**Operational note:** anyone with a live `data.db` from before this change must run `stop-server.sh` (which wipes state) before starting a post-change build. Documented in the tasks.md cutover step.

**Alternative considered:** leave columns + table present but stop reading/writing. Rejected — leaves a permanent "why are these columns NULL forever" question.

### D4. Delete the launcher (`launch-opencode.sh`) and `test-opencode-poke.mjs` entirely

**Chosen:** both files are deleted. Users start opencode as a plain tmux TUI (`tmux new-window; opencode`) and register via `register_agent({ client:'opencode', ui_pid: <pid>, ... })`. The daemon's existing pid → tty → pane binding path then populates `tmux_pane_id`.

**Rationale:** every line of `launch-opencode.sh` exists to support the HTTP transport + pre-reg flow being removed. Once that's gone, the script degenerates to `exec opencode "$@"`, which tmux + shell already provide. `test-opencode-poke.mjs` is a standalone harness for the HTTP transport and has no post-change meaning.

**Alternative considered:** simplify `launch-opencode.sh` to a thin "verify tmux, then exec opencode" helper. Rejected — it's strictly worse than `tmux new-window; opencode` and multiplies entry points.

### D5. Documentation: rewrite, don't prune

**Chosen:** rewrite the opencode sections of `README.md`, `README.zh-CN.md`, and `docs/configs/opencode.md` to describe the plain-tmux path end-to-end. Do not simply delete the sections, because "how do I use opencode with xats" is a question that still deserves an answer.

**Rationale:** a missing section would be more confusing than a short "here's the tmux-only way" section. The new copy is roughly 10% the size of the current content.

### D6. Test strategy for the removal

**Chosen:**
1. Delete the ten opencode-specific test files outright.
2. Update cross-cutting tests that currently exercise the opencode branch (notably `poke-*.test.ts`, `broadcast-*.test.ts`, `send-message*.test.ts`, `register-agent*.test.ts`, `agents-repo*.test.ts`, `transport-dispatch*.test.ts`) to the tmux-only path — replace `opencode_base_url` / `opencode_session_id` fixtures with `tmux_pane_id` setups where needed, delete scenarios that test removed code.
3. Add one small positive test: "`register_agent({client:'opencode', ui_pid})` binds the caller's pane and a subsequent poke from another agent delivers via `tmux-poke`". This locks in the intended post-change delivery path.

**Alternative considered:** keep some opencode tests as "transport removed" regression guards. Rejected — once the code is gone there's nothing to regress, and empty/negative tests are maintenance burden.

## Risks / Trade-offs

- **[Risk]** A live operator with a running daemon and non-empty `data.db` from before this change gets a database whose schema drifts from the new code (columns the code no longer reads; table it no longer writes to). → **Mitigation:** cutover task explicitly requires `./stop-server.sh` (wipes `data.db`) before starting the post-change daemon. Documented in tasks.md and the README opencode rewrite.
- **[Risk]** Downstream scripts that invoke `launch-opencode.sh` or one of the three removed MCP tools break silently. → **Mitigation:** proposal marks these as BREAKING; README + `docs/configs/opencode.md` describe the tmux replacement. No silent no-op shim is provided, which is intentional — silent shims are worse than a hard error for a single-operator project.
- **[Risk]** The post-change "register opencode via `register_agent({client:'opencode', ui_pid})`" path depends on the daemon's pid → tty → pane binding working for opencode. This path already exists and is exercised by `bind_runtime_identity` and the existing `register_agent` auto-bind logic, but any latent bug would now be user-facing for opencode. → **Mitigation:** the new positive test (D6 step 3) covers the happy path. If real usage surfaces issues with pid-based binding specifically for opencode, that's a bug in the existing generic path, not this change.
- **[Trade-off]** We lose the theoretical benefit of HTTP-level delivery (structured error codes like `opencode_session_busy`, async prompt_async semantics). In practice the path was never reliable enough to deliver that benefit, and tmux paste/Enter is the ground truth for every other TUI-based agent.

## Migration Plan

Operator-facing cutover (one host, one operator):

1. Stop the daemon: `./stop-server.sh` — also wipes `data.db`.
2. `git pull` / build the post-change code.
3. `./start-server.sh` — fresh `data.db` is created without the dropped columns/table.
4. Replace any shell alias pointing at `launch-opencode.sh` with plain `opencode`, invoked inside tmux.
5. Inside opencode, register: `register_agent({ client:'opencode', name:'...', model:'...', ui_pid: <opencode pid>, project_dir:'...' })`.

No reverse migration path. Rollback requires checking out the pre-change commit and re-running `stop-server.sh` / `start-server.sh`.

## Open Questions

None. Three decision points were resolved with the user during explore:

- Keep `ClientKind='opencode'` → yes.
- Delete launcher entirely → yes.
- Schema drops outright, no compat → yes.
