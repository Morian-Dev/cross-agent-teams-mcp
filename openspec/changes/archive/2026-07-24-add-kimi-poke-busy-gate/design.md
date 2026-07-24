# Design: add-kimi-poke-busy-gate

## D1: Gate on `main_turn_active`, not `busy`

`busy` is true when any agent has an active turn **or** a background task is alive; `main_turn_active` covers only the main agent's turn. A background task can run for a long time without conflicting with an injected prompt, so gating on `busy` would defer pokes that were perfectly safe to deliver.

## D2: `pending_interaction` is a distinct outcome, not a deferral

An approval-blocked session keeps its turn active, so `main_turn_active` stays true and `busy` stays true — permanently, until a human answers. Feeding that into the retry gradient means three retries that cannot possibly succeed, followed by silent exhaustion.

It gets its own outcome (`kimi_pending_interaction`) which is logged and surfaced rather than retried. Answering an approval is a human decision; the daemon must not make it, and must not pretend a retry will resolve it.

This matters more now that the team CLI maps `launcher: "normal"` onto `permission_mode: "manual"` — approval-blocked sessions become an ordinary state rather than an exotic one.

## D3: The wire.jsonl mtime heuristic, and why it is worth the coupling

The REST probe cannot see a TUI-side turn (D-blindspot in the proposal). The compensating signal is that a running TUI turn continuously appends to `~/.kimi-code/sessions/wd_*/<sid>/agents/main/wire.jsonl`; if that file was written within the last few seconds, a turn is probably in flight.

This couples the daemon to kimi's on-disk layout, which is exactly what was rejected earlier for session deletion. The distinction is deliberate:

- Reading a file's **mtime** does not depend on the file's format, only its path. A format change breaks nothing here; only a relocation does.
- The launcher already depends on this same path layout (it waits for `agents/main` to appear before attaching), so the coupling is not new.
- A missing or unreadable file must **fail open** (proceed with the injection). The heuristic can only ever add deferrals, never block delivery outright — a silently-never-firing check is the failure mode to avoid, not a delivery outage.

Failure modes, stated so the tests can pin them: mtime fresh but the turn just ended → an unnecessary deferral, harmless. mtime stale but the user is mid-turn and merely thinking → injection proceeds, which is the residual hole. The window is deliberately short (10s) to keep the first case rare, and the second case is bounded because an actually-executing turn writes continuously.

## D4: A separate retry scheduler, not a generalized one

`poke-retry.ts` is written around a tmux pane: `paneId` is required in `RetryPokeArgs`, the guard is `paneGuardFn(paneId)`, and the loop bails at `poke-retry.ts:75` when the agent has no `tmux_pane_id`. kimi agents never have one.

Generalizing it into a transport-agnostic scheduler is the better long-term shape, but it is live code on the tmux delivery path, and this whole gate is a mitigation that upstream intends to make unnecessary by collapsing the TUI onto the server engine. Rewriting shared delivery machinery for a mitigation with a planned expiry is the wrong trade. A separate `kimi-poke-retry.ts` reusing `RETRY_DELAYS_MS` keeps the blast radius at zero and is trivial to delete later.

The duplication is acknowledged and bounded: the delay ladder stays shared, only the scheduling loop is separate.

## D5: Exhaustion does nothing

After the last retry the daemon stops. It does not force the injection, does not escalate to tmux, and does not report a delivery failure to the sender beyond the existing status.

The mailbox row was written when the message was sent — delivery and wake-up are already separate concerns in this system. An agent that never got woken still sees the message on its next `get_inbox`. Forcing an injection into a busy session to avoid "losing" a wake-up would trade a cosmetic problem for the exact state divergence this change exists to prevent.

## D6: Observe-only for long-running turns

Injection returns a prompt id. A timer checks later whether that prompt is still active and logs it if so. No abort.

Duration is the wrong discriminator for "stuck": the runaway that motivated this looked like *no progress* (an identical TodoList round every ~10s for five minutes), while healthy poke-woken turns in this project routinely exceed five minutes doing real work. A timeout-abort would reliably kill the healthy case and only incidentally catch the sick one.

State is in-memory only. A daemon restart forgets outstanding observations, which is acceptable for something whose entire output is a log line; persisting it would be more machinery than the value justifies.

## Rejected alternatives

- **Gate on `busy`.** Defers pokes for background tasks that pose no conflict (D1).
- **Retry `pending_interaction` on the normal gradient.** Cannot succeed; burns three retries and then goes quiet (D2).
- **Generalize `poke-retry.ts` now.** Regression risk on the live tmux path for a mitigation with a planned expiry (D4).
- **Abort long turns.** Wrong discriminator; kills real work (D6, and the proposal's out-of-scope note).
- **Parse `wire.jsonl` contents for a definitive answer.** Couples to a format that will change, for a signal that is heuristic either way. mtime is the weakest coupling that carries the information.
