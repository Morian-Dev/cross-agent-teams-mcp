# Tasks: add-kimi-session-share-and-registry-logs

Ordered by dependency: kimi share (1) → lifecycle log sink (2) → kimi reconnect (3) → wire-age observability (4) → docs (5). Code tasks are TDD RED → GREEN.

## 1. kimi session share

- [ ] 1.1 RED: mirror the codex share suite for kimi — same `(device,team,name)` + same `delivery.session_id` registers share (both connections keep working, no takeover log, either can close without unbinding the other); different `session_id` takes over and closes prior sessions; a kimi register without a validated `kimi-server` delivery still takes over
- [ ] 1.2 GREEN: `sharedRuntimeKey` (src/mcp/register-agent.ts) returns `delivery.session_id` for `agent_type='kimi-code'` + `delivery.kind='kimi-server'`
- [ ] 1.3 Confirm codex share tests and all existing takeover tests pass unedited

## 2. Lifecycle log sink

- [ ] 2.1 RED: building the daemon via the CLI entry wires a real `mcpLog`; a takeover, a session close, and an orphan reap each produce their line on the daemon's log stream
- [ ] 2.2 GREEN: supply the sink in the daemon binary path (`src/cli.ts` / `src/daemon/server.ts` default), keeping the existing throwing-logger fallback
- [ ] 2.3 Verify no behavioural change beyond output: full suite passes with the sink active

## 3. kimi reconnect

- [ ] 3.1 RED: mirror the opencode reconnect suite — happy path rebinds and returns `(team, name, agent_id)`; stale/missing session → `session_not_found` with zero mutation; no matching row → `need_register`; kimi rows are never auto-resolved without an explicit `session_id`
- [ ] 3.2 RED: revalidation uses the poke dispatcher's token resolution (auth_token_ref, else token file) and a failed probe mutates nothing
- [ ] 3.3 GREEN: kimi branch in `src/mcp/reconnect.ts`; rebind under the kimi runtime key so a recovered connection shares with live engine connections instead of taking over
- [ ] 3.4 GREEN: reconnect tool description gains the kimi arm (base_url + session_id, REQUIRED session_id, launcher re-export note)

## 4. Wire-age observability

- [ ] 4.1 RED: proceed with wire age 14s → one `kimi_poke_proceeded` record with `wire_age_ms`; proceed with no wire log or age ≥ ceiling → no record; age 60s (over gate window, under ceiling) still proceeds — the ceiling never defers
- [ ] 4.2 GREEN: expose wire age from the precheck to the proceed path; emit through the existing `logGate` sink; ceiling default 120s, `KIMI_WIRE_AGE_OBSERVE_MS` override
- [ ] 4.3 Confirm gate decision tests pass unedited (observation must not perturb decisions)

## 5. Docs

- [ ] 5.1 README kimi sections: the share semantics (server-side re-register no longer kills the TUI connection; first register per fresh engine session is still expected), and the `kimi_poke_proceeded` record alongside the existing `kimi_poke_deferred` documentation
- [ ] 5.2 README reconnect/recovery guidance: kimi recovery path and the `unknown_agent` → re-register rule staying valid for all runtimes

## 6. Verification

- [ ] 6.1 `openspec validate add-kimi-session-share-and-registry-logs --strict` passes
- [ ] 6.2 Full suite passes (port-8799 failures accounted separately when run on a host with the live stack)
- [ ] 6.3 Live check, reusing existing sessions only: poke a kimi agent whose TUI is attached and confirm the TUI's MCP connection survives the server-side re-register (no "MCP server closed unexpectedly"); grep the daemon log for the takeover/close/reap lines after a normal restart cycle
