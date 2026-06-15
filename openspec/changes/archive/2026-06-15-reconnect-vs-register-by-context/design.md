## Context

A `claude-code` agent loses its live xats binding on two reconnect events, and
must re-establish identity:

- **Context clear** (same Claude process): conversation context is wiped, so the
  agent no longer knows its `(name, team)`. But `$PPID` is unchanged, and the
  daemon still holds a row with `runtime_ui_pid == $PPID`, so `reconnect` can
  reverse-look-up and recover the identity.
- **Restart + `resume`** (new Claude process): the agent closed Claude Code and
  resumed the conversation. `$PPID` has changed (new process), so `reconnect`'s
  `findByRuntimeUiPid(new $PPID)` returns zero matches → `need_register`. But the
  conversation context survived, so the agent DOES still know its `(name, team)`.

The two cases are complementary: exactly one anchor survives each event — `$PPID`
survives a clear, remembered identity survives a resume. The current guidance
(`buildStartupHint`, the `reconnect` tool description, and the `agent-reconnect`
/ `claude-channel-transport` specs) anchors on "`$PPID` unchanged" and routes
both cases — including remembered-identity resume — to `reconnect`, which the
agent cannot self-evaluate and which mis-handles the restart-resume case.

## Goals / Non-Goals

**Goals:**
- Re-anchor the recovery decision on "does the agent still remember its
  `(name, team)`?" via a fail-safe decision tree.
- Restart + resume (identity remembered) routes to `register_agent` with the
  remembered identity and current `$PPID`.
- Keep the change to guidance text + specs only; no daemon control-flow change.

**Non-Goals:**
- No change to `reconnect`'s reverse-lookup semantics or `register_agent`'s
  identity-key takeover behavior.
- No new daemon signal (e.g. proxy asking the daemon whether `$PPID` is known) —
  that was the rejected "daemon-assisted" alternative; pure agent self-report is
  enough and simplest.

## Decisions

**Decision 1: Decision anchor = remembered identity, not `$PPID`.**
The `startup_bind_hint` and the `reconnect` tool description embed:

```
On reconnect:
- Remember my (name, team)?  → register_agent(remembered name/team, ui_pid=$PPID)
                               + state which identity I re-registered as
- Don't remember?            → reconnect({ui_pid: $PPID})
                               → need_register? → ask the user
```

Priority: trust the agent's own context memory first, fall back to the daemon's
`$PPID` reverse-lookup, fall back to asking the user. Every branch degrades
safely.

**Decision 2: Remove the `$PPID is unchanged` condition from the guidance.**
It is unobservable to the agent and is false for restart-resume. The remembered-
identity question subsumes it.

**Decision 3: Resume → register directly + transparent statement (no pre-confirm).**
When the agent remembers its identity it registers directly with that
`(name, team)` and states in its reply which identity it used (transparency, not
silent). Only if the memory is genuinely unclear does it fall back to
`reconnect` → `need_register` → ask the user.

## Risks / Trade-offs

- **Mis-remembered identity**: if a resumed context is compressed and the agent
  registers under a wrong `(name, team)`, it registers as a wrong identity.
  Mitigated by (a) resume context is normally clear and rich in prior
  same-identity traffic, (b) transparent statement of the chosen identity, and
  (c) fall back to `reconnect`→ask-user when memory is unclear. Comparable in
  blast radius to the existing `reconnect` `$PPID`-reuse mis-match risk, and
  register-by-explicit-identity actually avoids the `$PPID`-reuse `ambiguous`
  failure mode.
- **Guidance-only enforcement**: the routing lives in prompt text the agent must
  follow; there is no daemon-side guard. Acceptable — this is identity recovery
  guidance, and the daemon has no context-memory signal to enforce on.
