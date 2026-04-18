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

## send + poke idiom (urgent messages)

`send_message`, `broadcast`, and `task_add` do NOT auto-poke the recipient(s) — they only persist to the mailbox / task list, and the recipient sees the new item on their next natural turn via `get_inbox` / `task_list`.

If a message is genuinely urgent, chain a `poke` after the send:

```
send_message({ to_agent_id: "<B>", body: "<content>" })
poke({ target_agent_id: "<B>", prompt: "inbox has <short nudge>, please get_inbox" })
```

For `broadcast` the convention is **per-recipient poke**: iterate each target agent_id from `list_agents` and `poke` them individually.  A mass-poke protocol would spam every pane on routine updates and is deliberately NOT provided.  The tool descriptions for `send_message` / `broadcast` / `task_add` each remind the caller of this pattern at registration time.

## Daemon keep-alive tuning

The daemon ships with two idle-tolerance knobs:

- `KEEP_ALIVE_TIMEOUT_MS` (default `120000`, 120s) — HTTP short-connection keep-alive window.  Applies to streamable-http POST clients like codex rmcp.
- `HEARTBEAT_INTERVAL_MS` (default `30000`, 30s) — application-level `notifications/heartbeat` emitted to every attached SSE sink.  Keeps long-lived subscription streams TCP-active through NAT / firewall idle timers.

To override (e.g. for ops tuning or for tests):

```
KEEP_ALIVE_TIMEOUT_MS=60000 HEARTBEAT_INTERVAL_MS=15000 node dist/cli.js daemon
```

**Honest limitation**: these mitigations widen the window but do NOT fully fix the codex rmcp idle-transport collapse ("error decoding response body").  The root cause is in codex's HTTP connection pool lacking retry-on-decode-error; it's outside this daemon's control.  If codex still crashes after `KEEP_ALIVE_TIMEOUT_MS` seconds of idle, restart codex and re-register.
