# Multi-agent Phase 2 walkthrough

Prerequisites:
1. Start the daemon: `npx ts-agent-teams daemon --port 9100`.
2. Confirm `curl http://127.0.0.1:9100/health` returns `{ "ok": true, ... }`.
3. Configure each agent per `opencode.md`, `claude-code.md`, `codex-cli.md` (MCP server name: `ts-agent-teams`).
4. Optional: if running inside tmux, see each agent's "Reporting your tmux pane id on register" section to enable cross-agent interrupt targeting.

Manual scenario (broadcast replaces human relay):
1. In each of opencode, Claude Code, Codex CLI, call `register_agent` with a distinct `role`.
2. From opencode, call `broadcast({ body: "shared context X" })`.
3. In Claude Code and Codex CLI, call `get_inbox({ since_event_id: 0 })`; both receive X.
4. From opencode, call `task_add({ title: "build login API" })`.
5. From Claude Code, `task_claim` then `task_complete` with a result.
6. From Codex CLI, `task_list` to confirm completed state.

Record stdout transcripts per agent as evidence.

## Cross-agent poke scenario (Change `add-poke-mcp-tool`)

After both agents have registered with `tmux_pane_id`:

1. Agent A calls `poke({ target_agent_id: "<B>", prompt: "new events waiting, please check" })`
2. Daemon captures B's pane tail, injects the prompt via bracketed paste, sends Enter, captures again
3. A receives `{ ok, pane_id, pane_tail_before, pane_tail_after }` and inspects the diff to decide whether B acknowledged
4. If no visible change, A may call `poke` again (soft limit: 3 times per short window)
5. If still silent, fall back to `send_message` (mailbox persistence) or escalate to the human

## Auto-poke on send

Since `add-auto-poke-on-send`, `send_message` **defaults to auto-poke** for both single-recipient (`to_agent_id`) and role-fanout (`to_role`) cases.  The daemon runs a quiet-guard against the recipient's tmux pane before firing poke:

1. Capture the recipient's `tmux capture-pane` tail.
2. Wait `POKE_QUIET_MS` milliseconds (default `2000`, positive-integer env override).
3. Re-capture and compare; only fire poke when the two captures match (pane has been idle).

When the guard fails (pane is active), has no pane registered, tmux is unavailable, or the target is the caller itself, the message is **still persisted** to the mailbox and the skip is reported in the response.

`broadcast` is **opt-in**: it does NOT auto-poke unless the caller passes `auto_poke: true`.  The default avoids mass-poke noise on team-wide announcements.

Response fields:

- `poked: boolean` — `true` iff at least one recipient received a successful poke.
- `poke_skip_reasons?: Array<{ agent_id, reason }>` — entries for recipients that were not poked.  `reason` is one of `no_pane`, `guard_failed`, `tmux_unavailable`, `self`.  Absent when the caller passed `auto_poke: false`, or when a broadcast uses its default (`auto_poke` omitted).

Tuning the guard window:

```
POKE_QUIET_MS=500 node dist/cli.js daemon   # shorter window for fast-moving teams
POKE_QUIET_MS=4000 node dist/cli.js daemon  # longer window to reduce interrupts
```

Invalid / non-positive values are ignored and fall back to the 2000ms default.

### Relationship to the old send + poke idiom (obsolete)

Earlier docs recommended chaining `send_message` + `poke` manually.  That pattern is obsolete: single-recipient and role-fanout `send_message` now auto-poke by default, and the `poke` tool itself remains as an **explicit** escape hatch (no guard, always fires) for the rare case where you know the target is busy but want to interrupt anyway.  You typically only need explicit `poke` when:

- You hit a `guard_failed` in `poke_skip_reasons` but need to interrupt regardless.
- You are sending a `broadcast` without `auto_poke: true` but want to poke one specific recipient.
- `task_add` does not auto-poke (by design — prevents task-add spam); chain `poke` per the agent you want to claim it.

## Daemon keep-alive tuning

The daemon ships with two idle-tolerance knobs:

- `KEEP_ALIVE_TIMEOUT_MS` (default `120000`, 120s) — HTTP short-connection keep-alive window.  Applies to streamable-http POST clients like codex rmcp.
- `HEARTBEAT_INTERVAL_MS` (default `30000`, 30s) — application-level `notifications/heartbeat` emitted to every attached SSE sink.  Keeps long-lived subscription streams TCP-active through NAT / firewall idle timers.

To override (e.g. for ops tuning or for tests):

```
KEEP_ALIVE_TIMEOUT_MS=60000 HEARTBEAT_INTERVAL_MS=15000 node dist/cli.js daemon
```

**Honest limitation**: these mitigations widen the window but do NOT fully fix the codex rmcp idle-transport collapse ("error decoding response body").  The root cause is in codex's HTTP connection pool lacking retry-on-decode-error; it's outside this daemon's control.  If codex still crashes after `KEEP_ALIVE_TIMEOUT_MS` seconds of idle, restart codex and re-register.
