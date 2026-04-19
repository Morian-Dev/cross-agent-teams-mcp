# Runtime verification notes — task 10.1

**Change**: add-claude-channel-transport
**Date**: 2026-04-19
**Operator**: user jtianling (owner Claude + sender Claude, both in project root)

## Scenarios

| Scenario | Verdict | Notes |
|---|---|---|
| (a) idle poke via channel | PASS | Channel tag injected; owner auto-reacted with expected reply; `transport_used=claude-channel`; no tmux. |
| (b) real mid-turn poke via channel (LLM generating) | PASS | Channel delivered without interrupting ongoing generation; owner reacted on next natural decision boundary; `transport_used=claude-channel`; no tmux. |

## Infrastructure observations

- Self-binding flow worked end-to-end: proxy startup → startup channel notification → owner Claude called `register_agent` then `bind_channel(channel_session_id)` → agents row updated → subsequent pokes routed via channel.
- Initial notification text (pre-fix) only said "请调 bind_channel"; Claude called bind_channel before register_agent and got `unknown_agent`. Fixed by `c4edd2f` (notification now instructs register_agent → bind_channel order explicitly).
- Proxy reconnect storm discovered via `list_agents` showing ~100 `channel-proxy-<pid>-<rand>` rows from a single pid. Root cause: random suffix in `daemon-client.ts:62` made every reconnect register under a fresh `(team, name)`, spamming the agents table. Fixed by `1969c34` (drop `-${random}` suffix; identity is now `channel-proxy-<pid>` — stable across reconnects, upsert reuses the row).
- `.mcp.json` for this project uses `--daemon-url http://127.0.0.1:9100/mcp` only (no `--agent-team` / `--agent-name`), which was the pivot from protocol-side binding (option B, multi-instance collision) to self-binding (option C).

## Files

- `runtime-idle-pane.txt` — idle scenario transcript
- `runtime-midturn-pane.txt` — mid-turn scenario transcript
- `runtime-verify-README.md` — procedure reference (from pre-existing evidence/)

## Deferred

- Runtime wire log (`runtime-wire.jsonl`, proxy stderr) was not captured in this session — proxy writes stderr to the spawning Claude Code, which does not surface it to the user in real time. Future runs could add `2>` redirection via the `.mcp.json` command wrapper if this needs archived capture.
