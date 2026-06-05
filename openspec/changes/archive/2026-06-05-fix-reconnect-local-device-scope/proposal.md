## Why

The `reconnect` tool's reverse lookup is broken on any daemon started with `--device <label>`. `AgentsRepo.findByRuntimeUiPid` filters `WHERE device = 'local'`, and the `agent-reconnect` spec itself bakes in the literal `device = 'local'`. But the device-namespace identity model stores local agents under the daemon's *configured* device label (`resolveLocalDevice`, derived from `--device` / `os.hostname()`), falling back to the literal `'local'` only when `--device` is unset.

As a result, on a daemon launched with e.g. `--device jt`, every local agent is stored under `device='jt'`, the `device = 'local'` filter never matches, and `reconnect({ ui_pid })` always returns `need_register` instead of recovering the prior `(team, name)` — defeating the feature's entire purpose on exactly the setups that use a device label. The `reconnect` feature was added after the device-namespace change and never aligned with its device-resolution rule; this is the follow-up correction.

## What Changes

- `AgentsRepo.findByRuntimeUiPid` takes the daemon's resolved local device label as an argument and filters on it, instead of the hardcoded literal `'local'`.
- The `reconnect` handler/service threads the daemon's local device (the same value `RegisterAgentService` receives via `deps.localDevice`) into that lookup.
- The literal `'local'` remains the correct value only when the daemon runs without `--device` (because `resolveLocalDevice` returns `'local'` in that case) — so single-host setups are unaffected.
- Audit the sibling default `const device = input.device ?? 'local'` at `agents-repo.ts:119` to confirm its callers already pass the resolved device (no behavior change expected; documented if a gap is found).
- The `agent-reconnect` spec is updated so its `device = 'local'` wording becomes "the daemon's configured local device label".

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-reconnect`: the reverse lookup is scoped to the daemon's configured local device label (via `resolveLocalDevice`) rather than the literal `device = 'local'`; the "recovers identity by ui_pid" and "scoped to local claude-code identities" requirements are reworded accordingly. Behavior is unchanged for daemons without `--device`.

## Impact

- **Code**: `src/storage/agents-repo.ts` (`findByRuntimeUiPid` signature gains a `localDevice` parameter); `src/mcp/reconnect.ts` (pass the resolved device into the lookup); `src/mcp/tools.ts` (wire the daemon's local device into the reconnect handler, mirroring how `register_agent` gets `localDevice`).
- **Wire/API**: none — the `reconnect` tool input/output shape is unchanged.
- **Tests**: add a regression test proving a daemon with `localDevice='jt'` resolves `reconnect(ui_pid)` to an agent stored under `device='jt'` (and still resolves under `'local'` when no device label is configured).
- **Out of scope**: codex reconnect (keyed on `thread_id`, not `ui_pid`); any change to the device-namespace identity model itself.
