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
