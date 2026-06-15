## 1. Update channel proxy startup hint

- [x] 1.1 In `plugins/cross-agent-teams-channel/src/cli.ts`, rewrite `buildStartupHint` to route re-establishment by remembered identity: remember `(name, team)` → `register_agent(remembered name/team, ui_pid=$PPID)` and state the re-registered identity; don't remember → `reconnect({ui_pid: $PPID})`, and on `need_register` ask the user.
- [x] 1.2 Remove the `$PPID is unchanged` condition from the hint text; keep the `bind_channel` clarification (only rebinds an already-bound session, else `unknown_agent`).

## 2. Update reconnect tool description

- [x] 2.1 In `src/mcp/tools.ts`, update the `reconnect` tool description (and any register/bind description referencing the resume case) so an agent that still remembers its `(team, name)` after a restart + resume (changed `$PPID`) is routed to `register_agent` with that identity, not `reconnect`; drop the "even when the agent still remembers its `(team, name)`" steering toward `reconnect`.

## 3. Verify

- [x] 3.1 Run `npx tsc --noEmit` and the channel/transport + reconnect test suites; confirm green.
- [x] 3.2 Run `openspec validate reconnect-vs-register-by-context --strict` and confirm the change validates.
