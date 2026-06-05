## Why

`broadcast` and `send_message({to_role})` currently exclude any team member whose `last_seen_at` is older than `ONLINE_MS` (5 minutes) — the excluded agent gets no mailbox row, no event, no poke, nothing (spec: mailbox "Fan-out routing skips offline recipients"). The same 5-minute window also drives the `online` flag in `list_agents`.

This 5-minute idle threshold is the wrong model for agents. An agent is not a human: not making an MCP call for 5 minutes does NOT mean it is unreachable. A standby agent whose Claude UI process (`runtime_ui_pid`) is still running — even after 10 idle days — is perfectly able to receive mail, yet today it is silently dropped from every broadcast, forcing callers to fall back to manual `list_agents` + per-agent `send_message`. The daemon already persists each local agent's `runtime_ui_pid` (and codex agents' `tmux_pane_id`); process existence is a far truer liveness signal than wall-clock idleness.

Two corrections, both validated against the current code (the actual wake path in `auto-poke-fanout.ts` already gates on pane/transport liveness, never on the 5-minute timer — the timer only bites in fan-out recipient selection and in the `online` display flag):

1. **Fan-out should not filter by idle time at all.** `broadcast` and `to_role` should deliver a mailbox row to every team member, exactly like a direct `send_message` — offline members keep their inbox row (cleaned by the existing 30-day retention). The live poke is still best-effort and self-gated by the existing pane/transport checks.
2. **`online` should mean "the process is alive", not "active in the last 5 minutes".** Probe liveness when the daemon can (local agent's `runtime_ui_pid` via `process.kill(pid, 0)`; codex agent's `tmux_pane_id` via pane existence); fall back to a day-level `last_seen_at` window only for agents the daemon cannot probe (remote agents, or agents with neither pid nor pane).

## What Changes

- **`broadcast` and `send_message({to_role}) fan-out stop excluding idle recipients.** They enumerate every team member (broadcast: all minus sender; to_role: all under role+team) and deliver a mailbox row to each, identical to direct-send semantics. `unknown_recipient` is returned ONLY when the member set is genuinely empty (broadcast: sender is the sole team member; to_role: no agent holds that role) — never merely because members are idle.
- **The `online` flag becomes process-liveness.** A new `isAgentLive(agent)` predicate replaces the `last_seen_at < now - ONLINE_MS` check:
  - local device + `runtime_ui_pid` set → process alive via `process.kill(pid, 0)` (reuses the existing `isAlive` logic in `src/daemon/pid.ts`);
  - local device + `tmux_pane_id` set (no `runtime_ui_pid`, e.g. codex) → the pane still exists (reuses tmux pane listing);
  - otherwise (remote device, or neither pid nor pane) → `last_seen_at` within a day-level window `REACHABLE_MS` (default 4 days).
- **`ONLINE_MS` (5 min) is retired** from both call sites; `REACHABLE_MS` (day-level fallback) is introduced. `list_agents` still returns every team row with the (now liveness-based) `online` flag.
- **Tool descriptions updated**: the `broadcast` / `send_message` descriptions no longer claim a 5-minute idle skip; they state broadcast/to_role deliver to all team members and that `online` reflects process liveness.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mailbox`: the "Fan-out routing skips offline recipients" requirement is replaced — `broadcast` and `to_role` deliver to every team member (no idle exclusion); `unknown_recipient` only on a genuinely empty member set. Direct-send behavior is unchanged.
- `agent-registry`: the `list_agents` `online` field is redefined from "`last_seen_at` within 5 minutes" to the `isAgentLive` process-liveness predicate (pid/pane probe, day-level `last_seen` fallback).

## Impact

- **Code**: `src/mcp/broadcast.ts` and `src/mcp/broadcast-to-role.ts` (drop the `last_seen_at > cutoff` recipient filter); `src/mcp/send-message.ts` (to_role path, same); `src/storage/agents-repo.ts` (replace the `online` computation with `isAgentLive`, retire `ONLINE_MS`, add `REACHABLE_MS`); a liveness helper (export `isAlive` from `src/daemon/pid.ts` or a small new module) plus a tmux pane-existence check (reuse `tmux-pane-detect` listing); `src/mcp/tools.ts` tool descriptions.
- **Behavior**: broadcasts now reach idle/standby agents reliably; offline agents accumulate inbox rows until 30-day cleanup (same as direct sends today). `online` reflects whether the agent's process is actually running.
- **Tests**: `tests/online-threshold.test.ts` (currently asserts `ONLINE_MS === 300000`) is updated/replaced; new liveness tests (pid alive/dead, pane present/absent, remote `last_seen` fallback); broadcast/to_role fan-out tests updated to expect all-member delivery; `unknown_recipient` retained only for the truly-empty cases.
- **Out of scope**: changing the auto-poke/quiet-guard wake path (already liveness-aware); pid-reuse hardening (a recycled pid could read as alive — accepted, worst case an inbox row for a dead agent, identical to direct-send today); any change to the 30-day retention contract.
