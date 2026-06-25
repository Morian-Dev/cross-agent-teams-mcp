## 1. Guard the tmux paste primitive

- [x] 1.1 In `src/mcp/poke.ts`, add `skipGuard?: boolean` to the `tmuxPokeImpl` args; after `isTmuxAvailable` passes and before `capture_before`, run `runQuietGuard(args.pane_id)` unless `skipGuard` is set
- [x] 1.2 On guard `fail`, return `{ error: 'guard_failed' }` from `tmuxPokeImpl` without loading/pasting/sending Enter
- [x] 1.3 Import `runQuietGuard` from `./poke-guard.js` into `poke.ts`

## 2. Thread `skipGuard` through the dispatch + poke chain

- [x] 2.1 In `src/mcp/transport-dispatch.ts`, add `skipGuard?: boolean` to `DispatchInput` (or a sibling param) and to the `tmuxPoke` dep signature; `dispatchTmux` forwards it into `deps.tmuxPoke({ pane_id, content, skipGuard })`
- [x] 2.2 In `src/mcp/poke.ts`, add `skipGuard?: boolean` to `PokeInput`; pass it through both `dispatchPoke` calls and the legacy `tmuxPokeImpl` call
- [x] 2.3 In `src/mcp/tools.ts` `createAutoPokeImpl`, add `skipGuard` to `AutoPokeArgs` handling and forward it into the `poke(...)` call; add an explicit `if (err === 'guard_failed') return { ok: false, reason: 'guard_failed' }` branch for clarity

## 3. Remove the fan-out's transport-type-gated guard

- [x] 3.1 In `src/mcp/auto-poke-fanout.ts`, delete the `if (!nonTmuxTransport) { const guard = await runQuietGuard(...) ... }` block so the fan-out always invokes the poke fn (the primitive now guards)
- [x] 3.2 In the retry-schedule wrapper (`auto-poke-fanout.ts`, the `pokeFn: async (pokeArgs) => { await pokeFn(pokeArgs) }`), pass `skipGuard: true` so retry-tick pokes do not double-guard
- [x] 3.3 Add `skipGuard` to `AutoPokeArgs` in `auto-poke-fanout.ts`; remove the now-unused `runQuietGuard` import if no longer referenced there, keeping the `paneGuardFn: runQuietGuard` used by retry scheduling intact

## 4. Tests

- [x] 4.1 Unit test: `tmuxPokeImpl` on an active pane (capture changes across the quiet window) returns `guard_failed` and issues no paste/Enter; on an idle pane it pastes normally
- [x] 4.2 Unit test: `tmuxPokeImpl` with `skipGuard: true` pastes on an active pane without running the guard
- [x] 4.3 Regression test: a `claude-channel` recipient with no live sink + active pane, via `send_message` auto-poke, resolves to `poked: false` + `poke_skip_reasons: [{reason:'guard_failed'}]` + `retry_scheduled: true`, and no paste reaches the pane
- [x] 4.4 Test: channel sink online → `send_message` delivers via channel, never reaches the tmux branch, no guard runs (delivery is not slowed by the guard)
- [x] 4.5 Test: retry tick whose own guard passes fires the poke with `skipGuard` set (the primitive does not run a second guard window)
- [x] 4.6 Update any existing poke/auto-poke tests that assumed the fan-out ran the guard, to reflect the guard living in the primitive

## 5. Verify

- [x] 5.1 `npm run typecheck` (or project equivalent) passes — confirms the `skipGuard` chain type-checks end to end
- [x] 5.2 Full test suite passes
- [x] 5.3 `openspec validate guard-tmux-paste-not-transport --strict` passes
