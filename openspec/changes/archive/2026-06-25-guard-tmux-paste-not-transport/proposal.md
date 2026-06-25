## Why

The tmux quiet-guard is gated by transport *type* (`nonTmuxTransport`) in the fan-out layer, but the internal poke primitive can still *fall back to a tmux paste* when the configured non-tmux transport is unreachable (e.g. a `claude-channel` agent whose channel sink is not subscribed, or an agent the user deliberately runs without a channel). That fallback paste runs **without any guard**, so a poke can paste text + Enter into a pane while the user is actively typing — exactly the disruption the guard was built to prevent. The retry loop is also bypassed, because the unguarded paste reports success instead of `guard_failed`.

Root cause: the guard lives at the wrong layer. It must be bound to the *paste action*, not to a transport-type guess made one layer up.

## What Changes

- The tmux paste primitive (the only place text is injected into a pane) runs the quiet-guard immediately before pasting; on activity it returns `guard_failed` and does NOT paste.
- The fan-out layer (`send_message` / `broadcast` / `broadcast_to_role`) stops running its own transport-type-gated guard. It always invokes the internal poke primitive, which guards itself iff it actually reaches the tmux paste branch.
- A non-tmux-transport recipient that falls back to a tmux paste against an active pane now correctly skips with `guard_failed` and enters the existing retry backoff — closing the loop that was previously broken.
- The poke primitive accepts an internal `skipGuard` flag. The retry tick (which already runs its own quiet-guard before firing) passes `skipGuard:true` so the paste primitive does not double-guard (avoids a redundant second `POKE_QUIET_MS` wait).
- No public MCP tool surface or response-envelope shape changes.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `agent-interrupts`: the tmux paste happy-path now runs the quiet-guard before paste (unless `skipGuard`); active pane yields `guard_failed` with no paste.
- `mailbox`: auto-poke for `send_message` / `broadcast` no longer gates the guard on transport type — the guard moves into the poke primitive's tmux branch and applies to the fallback paste; the retry tick passes `skipGuard` to avoid double-guarding.

## Impact

- Code: `src/mcp/poke.ts` (`tmuxPokeImpl` gains the guard + `skipGuard`), `src/mcp/transport-dispatch.ts` (`dispatchTmux` / `DispatchInput` carry `skipGuard`), `src/mcp/poke.ts` `poke()` (`PokeInput.skipGuard` passthrough), `src/mcp/auto-poke-fanout.ts` (remove the `if (!nonTmuxTransport) runQuietGuard` block; retry wrapper passes `skipGuard:true`), `src/mcp/tools.ts` (`createAutoPokeImpl` threads `skipGuard`).
- Behavior: a non-tmux recipient whose transport is down + active pane now skips with `guard_failed` + retry, instead of barging in. Normal channel/opencode delivery (transport reachable) is unaffected — it never reaches the tmux branch, so it never guards.
- No DB schema change, no MCP tool list change, no response envelope change.
