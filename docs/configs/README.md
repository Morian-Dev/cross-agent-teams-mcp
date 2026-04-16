# Multi-agent Phase 2 walkthrough

Prerequisites:
1. Start the daemon: `npx agent-teams-mcp daemon --port 9099`.
2. Confirm `curl http://127.0.0.1:9099/health` returns `{ "ok": true, ... }`.
3. Configure each agent per `opencode.md`, `claude-code.md`, `codex-cli.md`.

Manual scenario (broadcast replaces human relay):
1. In each of opencode, Claude Code, Codex CLI, call `register_agent` with a distinct `role`.
2. From opencode, call `broadcast({ body: "shared context X" })`.
3. In Claude Code and Codex CLI, call `get_inbox({ since_event_id: 0 })`; both receive X.
4. From opencode, call `task_add({ title: "build login API" })`.
5. From Claude Code, `task_claim` then `task_complete` with a result.
6. From Codex CLI, `task_list` to confirm completed state.

Record stdout transcripts per agent as evidence.
