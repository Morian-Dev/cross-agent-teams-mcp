## Context

The tmux quiet-guard (`runQuietGuard`: capture pane tail → wait `POKE_QUIET_MS` → recapture → compare) exists to avoid pasting a wake-up into a pane while the user is mid-typing. Today it is invoked in exactly one place: `fanoutAutoPoke` (`src/mcp/auto-poke-fanout.ts:76`), and only when `!nonTmuxTransport` — i.e. the recipient has NO configured non-tmux delivery.

Git history shows the regression was introduced incrementally:
- originally `runQuietGuard` ran unconditionally in the fan-out;
- `e620bab` wrapped it in `if (!explicitNonTmuxDelivery)`;
- `9fa456b` broadened that to `if (!nonTmuxTransport)` (any `delivery.kind != 'none'`).

The reasoning was sound for the happy path: codex-appserver / opencode-server / claude-channel transports don't paste into the user's pane, so a 2s tmux quiet window is meaningless for them. The flaw: the poke primitive (`dispatchPoke` → `dispatchClaude`/`dispatchCodex`/`dispatchOpencode`) has a **tmux fallback** (`transport-dispatch.ts`, step 6 of "poke dispatches via transport abstraction"). When a non-tmux transport is configured but unreachable (channel sink not subscribed, opencode down) the dispatch falls back to a tmux paste — and because the fan-out already skipped the guard for that recipient, the fallback paste runs unguarded.

So the guard's coverage (transport type) and the paste's reach (actual dispatch outcome) are misaligned. A `claude-channel` agent the user runs without a live channel, or simply hasn't subscribed yet, gets text + Enter pasted into the pane while typing. The retry loop is also lost: the unguarded paste reports `ok`, so no `guard_failed` → no retry.

## Goals / Non-Goals

**Goals:**
- Bind the quiet-guard to the tmux paste action so every paste path is guarded: legacy tmux-only poke, the dispatch tmux fallback (claude/codex/opencode), and any future paste path.
- Restore the `guard_failed` → retry-backoff loop for recipients that fall back to tmux against an active pane.
- Keep normal non-tmux delivery (channel/opencode reachable) guard-free and unslowed — it never reaches the tmux branch.
- Avoid double-guarding on the retry tick (which already runs its own guard).

**Non-Goals:**
- No change to which transport is preferred (channel > opencode > tmux ordering stays).
- No change to public MCP tool surface, tool list, or response envelopes.
- No new "skip tmux fallback entirely for channel agents" policy (rejected in exploration: users may deliberately run without a channel, where tmux is the primary route, not a fallback).
- No DB schema change.

## Decisions

### Decision 1: Move the guard into the tmux paste primitive (`tmuxPokeImpl`)

All three paste paths converge on `tmuxPokeImpl` (`src/mcp/poke.ts`): the legacy tmux-only branch calls it directly, and `dispatchTmux` calls it via the injected `deps.tmuxPoke`. Running `runQuietGuard` inside `tmuxPokeImpl` — after `isTmuxAvailable`, before `capture_before` — covers every path with one edit. On guard activity it returns `{error: 'guard_failed'}` and pastes nothing.

The fan-out's `if (!nonTmuxTransport) runQuietGuard` block is then **removed**: the guard is no longer the fan-out's concern. The fan-out always invokes the poke primitive; the primitive guards iff it reaches the paste.

**Alternative considered — keep guard in fan-out, broaden its condition to "will this reach tmux?":** rejected. The fan-out cannot know whether dispatch will fall back to tmux, because reachability (`channelWakeFanout.has(sid)`, opencode liveness) is only resolved inside `dispatchPoke`. Guessing at the fan-out layer is exactly the misalignment that caused the bug.

**Alternative considered — channel agents skip tmux fallback (explore direction 3):** rejected by the user: an agent may legitimately have no channel, making tmux the real route, not a degraded fallback. Skipping it would drop reachability for that whole class.

### Decision 2: Thread an internal `skipGuard` boolean so the retry tick doesn't double-guard

The retry tick (`poke-retry.ts:tick`) already runs `paneGuardFn` (= `runQuietGuard`) before firing the poke. If `tmuxPokeImpl` also guards, retry would wait two `POKE_QUIET_MS` windows. We add an optional `skipGuard` flag, default `false`, threaded along the internal call chain only:

```
AutoPokeArgs.skipGuard
  → createAutoPokeImpl (tools.ts) → poke(PokeInput.skipGuard)
  → dispatchPoke(DispatchInput.skipGuard) → dispatchTmux → tmuxPoke({..., skipGuard})
  → tmuxPokeImpl: if skipGuard, bypass runQuietGuard
```

- First-attempt fan-out path: passes nothing (default `false`) → primitive guards.
- Retry path: the retry wrapper built in `fanoutAutoPoke` (`auto-poke-fanout.ts:114`) hard-sets `skipGuard: true` when it calls the poke fn, because the tick has already guarded.

`skipGuard` is internal only; it is never added to any public MCP tool schema. `poke` is not a registered public tool, so no schema surface is touched.

**Alternative considered — accept the double-guard (explore option B):** functionally correct (the second guard almost always passes), but adds a silent extra 2s to each retry tick and leaves a "why is retry slow?" trap. Rejected in favour of the explicit flag.

**Alternative considered — remove the tick's own guard, let the primitive guard and report back:** rejected. The tick's `pokeFn` is typed `=> Promise<void>` and discards the result; the tick decides "reschedule vs. mark delivered" from the guard outcome it sees. Removing its guard would force plumbing the paste result back up through the retry wrapper — larger change than threading one boolean.

### Decision 3: `guard_failed` propagation reuses the existing mapping

`tmuxPokeImpl` returning `{error: 'guard_failed'}` flows through `dispatchTmux` (spreads error + `transport_used: 'tmux-poke'`) → `poke()` → `createAutoPokeImpl`. The existing fall-through in `createAutoPokeImpl` (`tools.ts:201`) already maps any unrecognised error to `reason: 'guard_failed'`, so the retry scheduler fires without changing the mapping. We will add an explicit `if (err === 'guard_failed')` branch for clarity, but behaviour is unchanged.

## Risks / Trade-offs

- **[Latency on the tmux paste path increases by `POKE_QUIET_MS` (~2s default).]** → No net change: the same 2s previously ran in the fan-out for tmux-only recipients. For non-tmux recipients that now fall back to tmux, the 2s is the intended, correct cost of not barging in. Fan-out parallelism (`Promise.all`) is unchanged, so broadcast wall-clock stays ~one window.
- **[A `skipGuard` leak to first-attempt paths would silently disable the guard again.]** → Default is `false`; only the retry wrapper sets `true`. A unit test asserts first-attempt fan-out paste guards, and retry paste does not double-guard.
- **[`skipGuard` threaded through 5 layers — wide surface for an off-by-one omission.]** → Each layer's param is optional and defaulted; type-checking catches a dropped link. Tests cover both the guarded and `skipGuard` branches at the primitive.

## Migration Plan

Pure internal behaviour fix. No schema/migration. Deploy = ship the daemon version. Rollback = revert the commit; nothing persisted depends on the change.

## Open Questions

None — direction (guard-on-paste) and the double-guard handling (`skipGuard` flag) were both settled during exploration.
