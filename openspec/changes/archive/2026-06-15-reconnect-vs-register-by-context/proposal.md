## Why

A `claude-code` agent recovers its xats identity after two different kinds of
reconnect, but the current guidance anchors the decision on whether `$PPID` is
unchanged — a signal the agent cannot self-check and that is simply wrong for
the "close Claude Code, then `resume` the conversation" case. On a restart +
resume the process is new (`$PPID` changed) but the conversation context — and
thus the agent's own `(name, team)` — is intact; `reconnect` reverse-looks-up
the new `$PPID`, finds nothing, and returns `need_register`, leaving the agent
to either loop or fall back as if it were a first-time registration. The real
signal distinguishing the two cases is whether the agent still remembers its
own `(name, team)`, which maps one-to-one to whether the context survived.

## What Changes

- Re-anchor the reconnect-vs-register decision on **"does the agent still
  remember its own `(name, team)`?"** instead of on whether `$PPID` is
  unchanged. The two recovery paths become a fail-safe decision tree:
  - **Remembers identity** (context survived, e.g. restart + `resume`) →
    `register_agent` with the remembered `(name, team)` and the current
    `$PPID`, then transparently state in the reply which identity was used.
  - **Does not remember** (context cleared) → `reconnect({ ui_pid: $PPID })`;
    on `need_register`, ask the user (first-time / memory also lost).
- Update the channel `startup_bind_hint` text (`buildStartupHint`) to embed this
  decision tree and **remove the `$PPID is unchanged` condition**, which the
  agent cannot evaluate and which mis-routes the restart-resume case.
- Correct the `agent-reconnect` requirement that currently routes **all**
  "resume" cases to `reconnect` "even when the agent still remembers its
  `(team, name)`": split the conflated "resume" into PPID-unchanged channel
  re-attach (→ `reconnect`) versus restart + resume with `$PPID` changed
  (→ `register_agent` with the remembered identity).
- Sync the `reconnect` tool description so it no longer steers a restart-resume
  agent toward `reconnect`.

This change is documentation/guidance only — no daemon control-flow or storage
changes. `reconnect`'s reverse-lookup semantics and `register_agent`'s
identity-key takeover behavior are unchanged; only the guidance that selects
between them changes.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `agent-reconnect`: the requirement guiding when an agent should call
  `reconnect` versus `register_agent` after a resume/reconnect changes — restart
  + resume (PPID changed, identity remembered) routes to `register_agent`, not
  `reconnect`; the decision anchor becomes remembered identity rather than
  "`$PPID` unchanged".
- `claude-channel-transport`: the `startup_bind_hint` text embeds the
  remember-identity decision tree and drops the `$PPID is unchanged` condition.

## Impact

- `plugins/cross-agent-teams-channel/src/cli.ts` — `buildStartupHint` text.
- `src/mcp/tools.ts` — `reconnect` tool description wording (and any
  register/bind description that references the resume case).
- Specs: `openspec/specs/agent-reconnect/spec.md`,
  `openspec/specs/claude-channel-transport/spec.md`.
- Behavioral contract for how Claude Code agents recover identity after a
  restart + `resume`; no wire-format, storage, or daemon-logic change.
