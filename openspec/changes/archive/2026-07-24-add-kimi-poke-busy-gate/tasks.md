# Tasks: add-kimi-poke-busy-gate

Ordered by dependency: session probe (1) → dispatcher gate (2) → retry path (3) → observation (4) → docs (5). Code tasks are TDD RED → GREEN.

## 1. Session state probe

- [x] 1.1 RED: `tests/kimi-session-state.test.ts` — probe returns `{ main_turn_active, pending_interaction }` from a 2xx `GET /api/v1/sessions/<sid>`; a rejected fetch, a non-2xx, an error envelope, and a body missing the fields all resolve to "no signal" (fail open), never to a deferral
- [x] 1.2 RED: wire-log heuristic — mtime within the window is recent, mtime outside it is not, a missing file is "no signal" (fail open)
- [x] 1.3 GREEN: `src/mcp/kimi-session-state.ts` with the probe and the mtime check; window is a named constant (10s)

## 2. Dispatcher gate

- [x] 2.1 RED: extend `tests/kimi-server-dispatch.test.ts` with the spec scenarios — `main_turn_active` defers with `reason: 'main_turn_active'` and issues NO POST; `busy` alone with an idle main turn injects; `pending_interaction != 'none'` returns `kimi_pending_interaction` and issues no POST; recent wire write defers with `reason: 'tui_recent_write'`; stale wire log injects; probe failure injects
- [x] 2.2 RED: a `SESSION_BUSY` envelope from `POST /prompts` maps to `kimi_session_busy` with `reason: 'session_busy_response'`, not to `kimi_inject_failed`
- [x] 2.3 GREEN: wire the probe into `dispatchKimiServerPoke` ahead of the POST; add the two deferral outcomes to `KimiServerDispatchResult`
- [x] 2.4 Confirm the existing kimi dispatch tests still pass unedited — the gate must be additive, and any pre-existing test needing a change means behaviour drifted

## 3. Kimi retry path

- [x] 3.1 RED: `tests/kimi-poke-retry.test.ts` — a `kimi_session_busy` result schedules retries on 30s/180s/600s and re-runs the precondition each time; a success on retry stops the ladder; `kimi_pending_interaction` schedules nothing; exhaustion performs no injection, no tmux fallback, and leaves the message readable
- [x] 3.2 GREEN: `src/mcp/kimi-poke-retry.ts` importing `RETRY_DELAYS_MS` from `poke-retry.js` — share the ladder, not the scheduler
- [x] 3.3 GREEN: add the deferral reasons to `AutoPokeSkipReason` and a second scheduling branch in `src/mcp/auto-poke-fanout.ts`, alongside the existing `guard_failed && paneId` branch
- [x] 3.4 Verify the tmux retry path is untouched: `poke-retry.ts` unmodified, its tests unedited and passing

## 4. Observation (no abort)

- [x] 4.1 RED: `tests/kimi-prompt-observe.test.ts` — a prompt still active at the threshold emits one log record; a finished prompt emits none; **no abort request is ever issued in either case**
- [x] 4.2 GREEN: record the prompt id when the injection response carries one; schedule an in-memory check at the threshold (default 10 min, configurable); log only
- [x] 4.3 Assert by grep that no abort endpoint is referenced anywhere in `src/` — the spec forbids exposing one at all, so absence is the requirement

## 5. Docs

- [x] 5.1 Document the gate in the kimi-code sections of `README.md` and `README.zh-CN.md`: what defers injection, that `main_turn_active` is used rather than `busy` and why, and the retry ladder
- [x] 5.2 State both blind spots plainly — the REST probe cannot see TUI-side turns (hence the wire-log heuristic), and check-then-inject is not atomic, so this is mitigation and not a guarantee
- [x] 5.3 State that long injected turns are logged and never aborted, and why elapsed time is not used as the discriminator

## 6. Verification

- [x] 6.1 `openspec validate add-kimi-poke-busy-gate --strict` passes
- [x] 6.2 Test suite passes, with the 4 known port-8799 failures accounted for separately (they fail identically at HEAD on a host running the live xats stack)
- [~] 6.3 Live check against the running kimi server: probe a session that is idle and one that is mid-turn, and confirm the gate decides differently. Reuse existing sessions — kimi sessions cannot be deleted, so every new one is permanent
  - Done: `GET /api/v1/sessions/<id>` on 6 live sessions returns exactly the parsed shape (`data.main_turn_active`, `data.pending_interaction: "none"`), all idle → `proceed`; dead port and unknown session both fail open → `proceed`; `isWireLogRecent` resolves the real `~/.kimi-code/sessions/wd_*/<id>/agents/main/wire.jsonl` path (true at a 1h window, false at the default 10s) so the heuristic is not silently never-firing.
  - Not done: the mid-turn branch was not observed live — every existing session was idle, and forcing one mid-turn means injecting a prompt into a real agent's session. Covered by unit tests against the verified live envelope shape.
