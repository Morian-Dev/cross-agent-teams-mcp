## Context

The `send_message` MCP tool already supports both same-team and cross-team 1→1 sends, and its service-layer failure semantics are clean: `unknown_recipient` covers both "no such name in team" and "name exists but in a different team than `to_team`" (see `src/mcp/send-message.ts:63-130`). Despite that, observed agent behavior is to call `list_agents` first as a pre-flight check before `send_message` — even when the user has explicitly named the recipient and target team. Two failure modes follow:

1. Cross-team pre-check: `list_agents` is caller-team scoped, so the cross-team target is never returned. The agent concludes the recipient doesn't exist and aborts the send.
2. Same-team pre-check: the call succeeds and the recipient is in the list, but the verification was pure waste — the subsequent `send_message` would have returned `unknown_recipient` cleanly on miss anyway.

The root cause is not in the server. Tool descriptions and the MCP server `instructions` field are silent on this anti-pattern, so the LLM's default defensive RLHF behavior wins.

## Goals / Non-Goals

**Goals:**
- Stop the cross-team pre-check failure mode by making the caller-team-only scope of `list_agents` explicit in its description.
- Stop the same-team waste by making `send_message`'s description explicitly forbid pre-verification and surface the `unknown_recipient` miss signal.
- Reinforce the rule at the server-instructions layer so it survives even when the LLM skims tool descriptions.

**Non-Goals:**
- No change to server-side behavior. `unknown_recipient` semantics are already correct.
- No change to `broadcast`, `broadcast_to_role`, or `send_message_by_id` descriptions. Their pre-check failure modes have not been observed; expanding scope risks churn without payoff.
- No new `list_agents` cross-team query mode. That would directly contradict the goal — it makes pre-checking *more* attractive, not less.

## Decisions

### Decision 1: Patch description text, not server behavior

Server-side `unknown_recipient` is already the right primitive. Adding cross-team `list_agents`, or changing the error code, would be solving the symptom not the cause. The cause is missing prose constraints in the LLM-visible surface.

Alternatives considered:
- **Add cross-team `list_agents`**: Rejected — encourages pre-check rather than discourages it.
- **Add a `dry_run` flag to `send_message`**: Rejected — invents a new affordance that callers would learn to use defensively, defeating the goal.

### Decision 2: Three-layer text reinforcement

Patch all three of: the `send_message` description, the `list_agents` description, and the MCP `instructions` field.

Rationale: the LLM does not consistently consume all three. Tool descriptions are loaded when the tool's schema is referenced; server `instructions` is loaded once at session `initialize`. The anti-pattern has to be visible at whichever surface the LLM reads first. The marginal cost of duplicating ~2 sentences across three locations is negligible against the cost of one false-negative cross-team send.

Alternatives considered:
- **Only patch `send_message` description**: Rejected — the bad call is `list_agents`, which the LLM may inspect first. `list_agents` needs its own warning.
- **Only patch server `instructions`**: Rejected — `instructions` is read at session start; per-tool descriptions are read at tool-binding time. Both windows matter.

### Decision 3: Tone — directive, not advisory

Use jussive prose like "DO NOT call `list_agents` to verify a target before `send_message`" and "`list_agents` is caller-team only and CANNOT see cross-team agents". This is intentionally louder than the surrounding description text.

Rationale: the observed problem is the LLM overriding implicit norms with defensive RLHF behavior. Soft hedges ("you may want to skip pre-verification") are absorbed by the same defensive instinct. Capitalized DO NOT / CANNOT / MUST NOT survives that filter.

## Risks / Trade-offs

- [Description bloat]: `send_message` description is already long. → Mitigation: cap the new sentence at one line each; do not restate `unknown_recipient` mechanics that are already in the spec.
- [Future agents may still pre-check]: This is a prose-only mitigation; future-model behavior is unpredictable. → Mitigation: the assertion tests pin the literal substring presence, so a future regression at the prose level fails CI. The 3-layer reinforcement also gives the LLM multiple chances to absorb the rule.
- [Drift with other tools]: `send_message_by_id` and `broadcast*` carry similar pre-check risk but are out of scope. → Mitigation: this is intentional; revisit only if those tools exhibit the same observed failure mode.

## Migration Plan

No runtime migration needed. Description / instructions text changes apply to every new MCP session at next process start. There is no persisted state shaped by these strings.
