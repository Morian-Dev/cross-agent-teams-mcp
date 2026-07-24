# Proposal: add-kimi-poke-busy-gate

## Why

A kimi poke is an unconditional `POST /api/v1/sessions/{sid}/prompts`. Nothing checks whether the session is already running a turn, so an injected turn can land on top of work in progress and two engines end up writing the same session.

This is not hypothetical. On 2026-07-21 a server-driven turn spun for ~5 minutes (a TodoList round every ~10s, no progress) after its MCP connection died, and was only stopped by a manual REST abort.

Two facts bound what this change can honestly claim, both established while scoping it:

- **The REST gate cannot see the TUI.** `busy` / `main_turn_active` reflect only the kimi *server* process engine. A turn the user is running in the TUI executes in the TUI's own in-process engine and is invisible over REST — the same dual-engine root cause behind the TUI not replaying server-driven turns. So a REST-only gate defends "injected turn on top of injected turn" and not "user is mid-turn in the TUI", which was the motivating case. A cheap on-disk heuristic (`agents/main/wire.jsonl` mtime) covers the second case well enough to be worth having.
- **Gating is check-then-inject, never atomic.** A turn can start between the check and the POST. Everything here is mitigation; the guarantee has to come from kimi collapsing the TUI onto the server engine upstream.

## What Changes

- Gate every kimi-server poke on a precondition check before injecting:
  - `GET /api/v1/sessions/{sid}` → defer while `main_turn_active` is true. Deliberately not `busy`, which also counts background tasks that may run long and should not block a poke.
  - `pending_interaction != 'none'` → do NOT defer on the normal gradient. An approval-blocked session keeps `main_turn_active` true and never self-heals, so retrying just burns the gradient. Surface it instead.
  - `agents/main/wire.jsonl` mtime within a short window → defer, as a heuristic for "the TUI is mid-turn".
- Treat a `SESSION_BUSY` rejection from `POST /prompts` as a deferral rather than a hard failure: enqueue may be refused instead of queued.
- Add a kimi-specific retry path reusing the existing 30s/180s/600s delays. The current scheduler cannot be reused: `poke-retry.ts` requires a `paneId` and bails at `if (!agent || !agent.tmux_pane_id)`, and kimi agents never have a pane.
- On gradient exhaustion, do nothing further. The mailbox row already exists, so the agent sees the message on its next `get_inbox`.
- Observe long-running injected turns: record the returned prompt id and, once past a threshold, log it. Do NOT abort.

## Capabilities

### Modified Capabilities

- `kimi-server-transport`: the dispatcher gains a precondition gate ahead of injection, two deferral outcomes (`kimi_session_busy`, `kimi_pending_interaction`), and a kimi-specific retry gradient.

## Impact

- `src/mcp/kimi-server-dispatch.ts`: precondition check ahead of the POST; `SESSION_BUSY` mapped to a deferral.
- New `src/mcp/kimi-session-state.ts`: session state probe and the wire.jsonl mtime heuristic.
- New `src/mcp/kimi-poke-retry.ts`: retry scheduler keyed on the precondition instead of a tmux pane guard.
- `src/mcp/auto-poke-fanout.ts`: a second scheduling branch for kimi deferrals; `AutoPokeSkipReason` gains the deferral reasons.
- `README.md` / `README.zh-CN.md`: document the gate, its two blind spots, and the observe-only behaviour.

## Explicitly out of scope

- **Aborting a long-running injected turn.** Elapsed time cannot distinguish a stuck turn from a productive one — poke-woken turns in this project routinely run past five minutes doing real work, and a duration-based abort would kill them. The observed failure was *no progress*, not *long*, and detecting that needs turn-progress detail kimi does not expose today. Log first, gather data, revisit.
- **Fixing the dead MCP connection that caused the runaway.** That is a kimi-side defect with an upstream fix planned; this change only limits the blast radius.
