## 1. Liveness predicate

- [x] 1.1 Expose a reusable process-alive check: export `isAlive(pid)` from `src/daemon/pid.ts` (or lift it into a small `liveness` helper) instead of re-implementing `process.kill(pid, 0)`.
- [x] 1.2 Add a tmux pane-existence check that reuses the existing pane listing (`src/daemon/tmux-pane-detect.ts`); it MUST batch a single `list-panes` call per evaluation pass, and degrade gracefully (fall through, not throw) when tmux is unavailable.
- [x] 1.3 Add `isAgentLive(agent, { localDevice, livePanes })` in `src/storage/agents-repo.ts` implementing the 3-rule resolution: local+`runtime_ui_pid` → pid alive; local+`tmux_pane_id` → pane exists; else → `last_seen_at >= now - REACHABLE_MS`.
- [x] 1.4 Introduce `REACHABLE_MS` (day-level, default 4 days) in `src/storage/agents-repo.ts` and retire `ONLINE_MS` from the `online`-flag computation.

## 2. list_agents online flag

- [x] 2.1 Change the `online` field computation (the row builder in `src/storage/agents-repo.ts` / `src/mcp/agent-public-row.ts`) to use `isAgentLive` with the daemon's `localDevice`, computing the live-pane set once per `list_agents` call.

## 3. Fan-out delivers to all members

- [x] 3.1 `src/mcp/broadcast.ts`: remove the `last_seen_at > cutoff` recipient filter; select every team member except the sender. Return `unknown_recipient` only when that set is empty (sender is the sole member).
- [x] 3.2 `src/mcp/broadcast-to-role.ts` and the `to_role` path in `src/mcp/send-message.ts`: remove the idle filter; select every agent under the role+team. Return `unknown_recipient` only when no agent holds the role.
- [x] 3.3 Confirm the auto-poke / retry path is unchanged (still self-gated by pane/transport); offline members get a mailbox row but no special-cased poke handling.

## 4. Tool descriptions

- [x] 4.1 Update the `broadcast` and `send_message` MCP tool descriptions in `src/mcp/tools.ts`: drop the "skips agents idle > 5 min" wording; state that broadcast/to_role deliver to all team members and that `online` reflects process liveness.

## 5. Tests

- [x] 5.1 Replace/​update `tests/online-threshold.test.ts` (it currently asserts `ONLINE_MS === 300000`) to cover `REACHABLE_MS` and `isAgentLive`.
- [x] 5.2 Add liveness tests: local agent with a live pid → online; dead pid → offline; local codex agent with present/absent pane → online/offline; remote agent within/beyond `REACHABLE_MS` → online/offline.
- [x] 5.3 Update broadcast/to_role fan-out tests: idle members ARE now included in `recipients` and DO get mailbox rows; `unknown_recipient` only when the member set is genuinely empty (broadcast sole-sender; to_role no-match).
- [x] 5.4 Keep a direct-send regression test proving direct `send_message` behavior is unchanged.

## 6. Verify

- [x] 6.1 Run the full test suite (`vitest`) — all green.
- [x] 6.2 Run `openspec validate --specs` — passes.
