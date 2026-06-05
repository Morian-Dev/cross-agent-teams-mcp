## Context

`reconnect` (capability `agent-reconnect`) reverse-looks-up the agents table on `runtime_ui_pid` to recover a lost `(team, name)`. Its lookup, `AgentsRepo.findByRuntimeUiPid`, hardcodes `WHERE device = 'local'`. The device-namespace model (`add-cross-host-device-namespace`) made the local device label configurable via `--device` (`resolveLocalDevice` in `src/daemon/local-device.ts`), so local agents are stored under that label (e.g. `'jt'`), not the literal `'local'`. The `reconnect` feature shipped after that change and never adopted the resolution rule, so the lookup silently never matches on `--device` daemons.

`RegisterAgentService` already receives the resolved label as `deps.localDevice` and uses it in `resolveEffectiveDevice`. The fix mirrors that wiring for the reconnect path.

## Goals / Non-Goals

**Goals:**
- `reconnect` resolves identities stored under the daemon's actual local device label.
- Zero behavior change for daemons started without `--device` (label resolves to `'local'`).
- A regression test pins the `--device jt` case.

**Non-Goals:**
- No change to the device-namespace identity model.
- No change to the `reconnect` tool wire shape.
- Codex reconnect (keyed on `thread_id`) stays out of scope.

## Decisions

- **Thread the label, don't re-derive it.** `findByRuntimeUiPid(ui_pid, localDevice)` gains a parameter; the caller (reconnect handler in `tools.ts`) passes the same `localDevice` the daemon already computed and handed to `RegisterAgentService`. This keeps a single source of truth for "what is this daemon's device" rather than calling `resolveLocalDevice` again deeper in the stack.
- **Keep the literal fallback semantics implicit.** Because `resolveLocalDevice` returns `'local'` when `--device` is unset, passing the resolved label naturally preserves the old single-host behavior without a special case.
- **Audit, don't blindly change, `agents-repo.ts:119`.** The sibling `const device = input.device ?? 'local'` accepts a caller-supplied device; confirm its callers feed the resolved label. Only adjust if a real gap exists, to keep the change surgical.

## Risks / Trade-offs

- **PID reuse** is pre-existing and unchanged by this fix: a recycled `runtime_ui_pid` could match a stale row. `last_seen_at DESC` ordering and the existing `ambiguous` path bound the blast radius; out of scope here.
- **Signature change** to `findByRuntimeUiPid` is internal-only (single caller), so the churn is minimal and contained.
