# Design: add-kimi-session-share-and-registry-logs

## D1: kimi's stable runtime key is the kimi session id

`sharedRuntimeKey` (register-agent.ts:46) is the single decision point for "share vs take over": codex returns `delivery.thread_id`, everything else returns `undefined`, and `canShare` requires a defined key. The kimi arm returns `delivery.session_id` when `agent_type='kimi-code'` and the validated delivery kind is `kimi-server`.

The symmetry is exact, not superficial. A codex `thread_id` and a kimi `session_id` play the same role: a stable conversation identity that outlives any single MCP connection, already REQUIRED at registration, already carried in the delivery row, and shared by both engine-side connections of one logical agent. The TUI engine registers with it (from the launcher env) and the server engine re-registers with it (from its conversational context) — same key, so they share; a *different* kimi session registering the same name has a different key and still takes over, which is the covering behaviour jt confirmed as expected.

What sharing fixes, precisely: the server-side re-register stops closing the TUI's connection. It does NOT remove the server side's need to register once per new MCP session — that first `unknown_agent` → register on a fresh server engine session is unchanged and correct.

## D2: Bound-session accumulation is accepted, with evidence

Shared bound sessions are exempt from orphan GC (`transport.ts:436` skips any session with a bound holder), so each server-engine MCP session that ever registered stays until its transport closes. This was raised as a slow-leak risk during review of the proposal.

Measured reality (kimi source + live event stream, 2026-07-24): the kimi v2 engine resolves MCP config and connects **once per session resume**, not per turn — `mcp.server.status=connected` appears once after resume and never again across turns. Accumulation rate is therefore cold-resumes + TUI restarts, single digits per day, same shape codex already lives with. A recycler would be speculative machinery; the trait is documented instead. Revisit only if the lifecycle logs (D3) show otherwise.

## D3: The logging change is a sink, not new events

Every event needed to diagnose binding incidents is already emitted: `mcp session closed: sid=… had_agent=…` (transport.ts:148), `register_agent takeover: old=… new=…` (register-agent.ts:234, and already REQUIRED by the takeover spec), `mcp orphan session reap: sid=… reason=…` (transport.ts:192). They all flow through `log()` → `opts.log?.()` — and `mcpLog` is never supplied by the daemon binary, so every line is silently discarded. The 2026-07-24 forensic pass had to reconstruct from source what one grep of a log file should have answered.

The change is exactly: the daemon binary supplies a real sink (console output, which the launchers already append to the daemon log file). No new event types, no log framework, no verbosity flag — if the volume ever matters, that is a later problem; today's volume is a handful of lines per session lifecycle.

## D4: kimi reconnect mirrors opencode, including revalidation

The opencode branch of `reconnect` is the template: reverse-look-up the local agents row by the delivery pair, revalidate against the live server, rebind only on success, mutate nothing on failure. For kimi: match `delivery.kind='kimi-server'` rows on `(base_url, session_id)`, revalidate with `GET <base_url>/api/v1/sessions/<session_id>` using the standard token-file bearer (the same auth the poke dispatcher already uses), and return `session_not_found` without mutating any row when the session is gone.

Revalidation is not optional politeness: kimi sessions can never be deleted but CAN be archived, and a reconnect onto a stale session id would recreate exactly the wrong-session poke misdelivery the launcher's pre-create flow exists to prevent.

Who calls this: a kimi server-side turn that lost its context. It knows its `base_url` (the MCP config it loaded) and can be told its `session_id` by the operator or a teammate — or, in the common case, the whole recovery is jt restarting the TUI, whose launcher re-exports both. The tool description gains the kimi arm so the guidance is discoverable.

Pre-existing spec drift, deliberately untouched: the agent-reconnect scoping requirement still says codex is out of scope and does not mention opencode, though both are implemented. Correcting that history is not this change's job; the kimi requirement is ADDED standalone.

## D5: `kimi_poke_proceeded` logs only near the window

A "missed defer" (probe saw a stale wire during a thinking-gap silence and correctly proceeded) is indistinguishable from a true idle at probe time — the daemon cannot log misses, only proceeds. Logging every proceed would bury the signal; logging none leaves window tuning evidence-free, which is how the 10s-vs-30s question stalled.

So: when the gate proceeds AND the wire age is below 120s (`KIMI_WIRE_AGE_OBSERVE_MS` to override), emit `{"event":"kimi_poke_proceeded","session_id":…,"wire_age_ms":…}`. Post-hoc, an injection that raced a TUI turn shows up as a proceed with a small `wire_age_ms` — exactly the double-sided evidence (defer records + near-miss records) a future tuning decision needs. Idle sessions (age far above the ceiling) log nothing.

The ceiling is an observation filter, not a second gate: it never affects the inject/defer decision.

## Rejected alternatives

- **Share by name whenever agent_type matches** (no key): re-opens the door to two *different* kimi sessions silently co-owning one identity — the misdelivery class the explicit-session-id design exists to kill.
- **A verbosity flag / structured log framework for D3**: machinery without a driver. The dropped lines are few and already formatted.
- **Skipping revalidation on kimi reconnect**: rebinding onto an archived/stale session silently misroutes pokes; opencode's revalidate-first precedent exists for the same reason.
- **Logging every proceed**: noise swamps the near-miss signal the record exists to capture.
