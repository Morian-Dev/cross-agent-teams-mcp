## ADDED Requirements

### Requirement: Near-window proceeds log the wire age

When the precondition gate decides to proceed AND the session's wire log exists with an age below an observation ceiling (default 120 000 ms, `KIMI_WIRE_AGE_OBSERVE_MS` to override), the dispatcher SHALL emit a structured log record `{ "event": "kimi_poke_proceeded", "session_id": <sid>, "wire_age_ms": <age> }` through the same gate-logging sink that carries `kimi_poke_deferred`.

Rationale, stated so the record is not later "optimized away": a missed deferral — the probe correctly reading a stale wire during a thinking-gap silence while a TUI turn is actually in flight — is indistinguishable from a true idle at probe time, so misses cannot be logged directly. A proceed with a *small* `wire_age_ms` is the observable shadow of that case. Together with the deferral records this gives window-tuning decisions double-sided evidence; the 10s window itself was deliberately kept and any future widening must cite these records.

The ceiling is an observation filter only. It MUST NOT influence the inject/defer decision, and proceeds with no wire log or an age at or above the ceiling MUST log nothing (idle sessions stay quiet).

#### Scenario: A near-window proceed is recorded

- **GIVEN** the gate proceeds and the session's wire log was last written 14 seconds ago
- **WHEN** the poke is injected
- **THEN** a `kimi_poke_proceeded` record with `wire_age_ms` ≈ 14000 is logged
- **AND** the injection itself is unaffected

#### Scenario: An idle session logs nothing on proceed

- **GIVEN** the gate proceeds and the wire log was last written an hour ago (or does not exist)
- **WHEN** the poke is injected
- **THEN** no `kimi_poke_proceeded` record is emitted

#### Scenario: The ceiling does not defer

- **GIVEN** a wire age of 60 seconds (below the ceiling, above the 10s gate window)
- **WHEN** the gate evaluates
- **THEN** the decision is proceed — the ceiling never converts a proceed into a deferral
