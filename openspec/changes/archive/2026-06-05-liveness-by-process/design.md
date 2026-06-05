## Context

The 5-minute `ONLINE_MS` window does two jobs today: (a) it filters `broadcast` / `to_role` recipients (mailbox "Fan-out routing skips offline recipients"), and (b) it computes the `list_agents` `online` flag (agent-registry "list_agents scoped to caller team"). Investigation of `src/mcp/auto-poke-fanout.ts` shows the actual wake path never consults this window — it gates pokes on pane existence + quiet-guard (tmux) or transport presence (channel/codex). So the 5-minute timer's only effects are the recipient filter and the display flag; both are the targets of this change.

The daemon already persists `runtime_ui_pid` (claude UI pid) and `tmux_pane_id`, and `src/daemon/pid.ts` already has a correct `isAlive(pid)` using `process.kill(pid, 0)` (EPERM ⇒ alive). Pane enumeration exists in `src/daemon/tmux-pane-detect.ts`.

## Goals / Non-Goals

**Goals:**
- `broadcast` / `to_role` deliver a mailbox row to every team member, like direct sends — no idle exclusion.
- `online` reflects real process liveness (pid/pane), with a day-level `last_seen` fallback only when the daemon cannot probe.
- Keep the wake path untouched (it is already liveness-aware).

**Non-Goals:**
- No change to direct `send_message` / `send_message_by_id` (already unfiltered).
- No change to the auto-poke / quiet-guard / retry machinery.
- No pid-reuse hardening (out of scope; accepted risk).
- No change to 30-day retention.

## Decisions

- **Delivery = all members; liveness only drives the display flag.** Per jt's "broadcast 和 send_message 一个意思", fan-out stops filtering entirely rather than swapping the 5-min window for a pid-based delivery gate. This keeps delivery durable (inbox row for everyone) and makes liveness a pure `list_agents` concern — which also bounds the cost of any tmux probing to `list_agents` calls, not every broadcast.
- **`isAgentLive(agent)` resolution order** (first match wins):
  1. `device === localDevice` AND `runtime_ui_pid` set → `isAlive(runtime_ui_pid)`.
  2. `device === localDevice` AND `tmux_pane_id` set → pane exists in the current `tmux list-panes` set.
  3. otherwise (remote device, or local with neither pid nor pane) → `last_seen_at >= now - REACHABLE_MS`.
- **`REACHABLE_MS` default = 4 days.** A single constant in `agents-repo.ts` replacing `ONLINE_MS`. No env override unless a need appears (YAGNI).
- **Reuse, don't duplicate.** Export the existing `isAlive` from `src/daemon/pid.ts` (or lift it into a tiny `liveness` helper) rather than re-implementing `process.kill`. Reuse the existing pane-listing helper for pane existence; batch one `list-panes` call per `list_agents` invocation rather than per agent.
- **`unknown_recipient` semantics narrow.** Fan-out returns it only when the enumerated member set is empty (broadcast: sole member is the sender; to_role: zero agents under the role). Idle members no longer empty the set.

## Risks / Trade-offs

- **Inbox growth for dead agents.** Broadcasting to everyone means long-dead agents accrue mailbox rows until the 30-day cleanup — identical to how direct sends already behave, and explicitly what jt asked for. Acceptable.
- **PID reuse false-positive.** A recycled `runtime_ui_pid` could report a dead agent as `online`. Worst case is a misleading display flag (delivery is unaffected since delivery no longer depends on liveness). Pre-existing class of issue; out of scope.
- **tmux probe cost.** Pane existence requires shelling out to `tmux list-panes`. Mitigated by probing once per `list_agents` call and only for local codex-style rows; pid checks are cheap syscalls. If tmux is unavailable, pane-based liveness degrades to the `last_seen` fallback rather than erroring.
- **Behavioral change is observable.** Callers that relied on `broadcast` "recipients" meaning "currently online" will now see all members. This is the intended correction; tool descriptions are updated so the contract is clear.
