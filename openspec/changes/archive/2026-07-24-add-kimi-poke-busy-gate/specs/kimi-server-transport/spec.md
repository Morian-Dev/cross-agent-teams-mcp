## ADDED Requirements

### Requirement: kimi-server poke is gated on a session precondition check

Before issuing `POST /api/v1/sessions/{session_id}/prompts`, the dispatcher SHALL probe the target session and MAY decline to inject. The probe consists of:

1. `GET <base_url>/api/v1/sessions/<session_id>` with the same bearer token used for injection.
2. Reading the mtime of the session's main-agent wire log at `~/.kimi-code/sessions/*/<session_id>/agents/main/wire.jsonl`.

Outcomes, in precedence order:

- `pending_interaction` is present and not `'none'` → `{ error: 'kimi_pending_interaction', detail: { pending_interaction: <value> }, transport_used: 'kimi-server' }`. The dispatcher MUST NOT inject and this outcome MUST NOT enter the retry gradient (see the retry requirement).
- `main_turn_active` is true → `{ error: 'kimi_session_busy', detail: { reason: 'main_turn_active' }, transport_used: 'kimi-server' }`. The dispatcher MUST NOT inject.
- The wire log was modified within the last 10 seconds → `{ error: 'kimi_session_busy', detail: { reason: 'tui_recent_write' }, transport_used: 'kimi-server' }`. The dispatcher MUST NOT inject.
- Otherwise → proceed to injection.

The gate SHALL be evaluated on `main_turn_active`, NOT on `busy`. `busy` is also true while a background task is alive, and a background task does not conflict with an injected prompt.

Both probe inputs MUST fail open: if the `GET` fails, returns a non-2xx, returns an error envelope, or omits the fields, and likewise if the wire log is missing or unreadable, the dispatcher SHALL proceed to injection rather than defer. A probe that silently never fires must degrade to today's behaviour, never to a delivery outage.

The gate is check-then-inject and therefore NOT atomic: a turn may begin between the probe and the POST. It is a mitigation and MUST NOT be specified, tested, or described as a guarantee that concurrent turns cannot occur.

The wire-log check is a heuristic for TUI-side activity, which the REST probe cannot observe at all: `main_turn_active` and `busy` reflect only the kimi server process engine, while a turn the user runs in the TUI executes in the TUI's own in-process engine.

#### Scenario: Active main turn defers injection

- **GIVEN** `GET /api/v1/sessions/<sid>` returns `data.main_turn_active = true` and `pending_interaction = 'none'`
- **WHEN** the daemon dispatches a kimi poke
- **THEN** no `POST /prompts` request is issued
- **AND** the dispatcher returns `{ error: 'kimi_session_busy', detail: { reason: 'main_turn_active' }, transport_used: 'kimi-server' }`

#### Scenario: Background task alone does not defer

- **GIVEN** the session reports `busy = true` but `main_turn_active = false` and `pending_interaction = 'none'`
- **AND** the wire log has not been written recently
- **WHEN** the daemon dispatches a kimi poke
- **THEN** the prompt IS injected

#### Scenario: Pending interaction is reported, not retried

- **GIVEN** the session reports `pending_interaction = 'approval'`
- **WHEN** the daemon dispatches a kimi poke
- **THEN** no `POST /prompts` request is issued
- **AND** the dispatcher returns `{ error: 'kimi_pending_interaction', detail: { pending_interaction: 'approval' }, transport_used: 'kimi-server' }`

#### Scenario: Recent wire-log write defers injection

- **GIVEN** the session reports `main_turn_active = false` and `pending_interaction = 'none'`
- **AND** the session's `agents/main/wire.jsonl` was modified 2 seconds ago
- **WHEN** the daemon dispatches a kimi poke
- **THEN** the dispatcher returns `{ error: 'kimi_session_busy', detail: { reason: 'tui_recent_write' }, transport_used: 'kimi-server' }`

#### Scenario: A stale wire log does not defer

- **GIVEN** the session reports `main_turn_active = false` and `pending_interaction = 'none'`
- **AND** the session's `agents/main/wire.jsonl` was last modified 10 minutes ago
- **WHEN** the daemon dispatches a kimi poke
- **THEN** the prompt IS injected

#### Scenario: Probe failure fails open

- **GIVEN** `GET /api/v1/sessions/<sid>` rejects, times out, or returns an error envelope
- **AND** the session's wire log does not exist
- **WHEN** the daemon dispatches a kimi poke
- **THEN** the prompt IS injected, exactly as it would have been before this gate existed

### Requirement: kimi deferrals retry on a kimi-specific gradient

A kimi poke that returned `kimi_session_busy` (from the precondition gate or from a `SESSION_BUSY` injection rejection) SHALL be retried on the delays already used for tmux guard failures — 30s, 180s, 600s — re-running the full precondition check on each attempt.

Retries SHALL be scheduled through a kimi-specific path. The existing tmux scheduler cannot serve them: it requires a pane id and abandons any agent whose `tmux_pane_id` is null, which is every kimi-code agent.

`kimi_pending_interaction` SHALL NOT be retried. The blocking condition is an unanswered human approval; it keeps the turn active indefinitely, so retrying only exhausts the gradient without any possibility of success.

When the gradient is exhausted the daemon SHALL take no further action: it MUST NOT force the injection, MUST NOT fall back to tmux, and MUST NOT rewrite the message. The mailbox row is already durable and the recipient sees the message on its next `get_inbox`; a wake-up is an optimisation over that, not a delivery mechanism.

#### Scenario: A busy session is retried and eventually delivered

- **GIVEN** a kimi poke deferred with `kimi_session_busy`
- **WHEN** the first retry runs and the session now reports `main_turn_active = false`
- **THEN** the prompt is injected on that retry

#### Scenario: Exhausting the gradient leaves the mailbox untouched

- **GIVEN** a kimi poke deferred with `kimi_session_busy` on the initial attempt and on all scheduled retries
- **WHEN** the last retry has run
- **THEN** no further injection is attempted and no tmux fallback occurs
- **AND** the message row remains readable through `get_inbox`

#### Scenario: Pending interaction does not enter the gradient

- **GIVEN** a kimi poke that returned `kimi_pending_interaction`
- **WHEN** the dispatcher result is processed
- **THEN** no retry is scheduled for that recipient

### Requirement: Injected turns are observed but never aborted

After a successful injection the dispatcher SHALL record the prompt identifier returned by the kimi server, when the response carries one. After a configurable threshold (default 10 minutes) the daemon SHALL check whether that prompt is still active via `GET /api/v1/sessions/<session_id>/prompts` and SHALL emit a log record when it is.

The daemon SHALL NOT abort the prompt, and MUST NOT expose an option that aborts it on elapsed time alone. Duration does not distinguish a stuck turn from a productive one: poke-woken turns in normal use routinely run for many minutes doing real work, while the observed pathological case was a turn making no progress. Acting on the former to catch the latter destroys more work than it saves.

Observation state MAY be held in memory only; losing it across a daemon restart is acceptable for a facility whose only output is a log record.

#### Scenario: A long-running injected turn is logged, not stopped

- **GIVEN** an injected prompt that is still active when the threshold elapses
- **WHEN** the observation check runs
- **THEN** a log record identifying the session and prompt is emitted
- **AND** no abort request is sent to the kimi server

#### Scenario: A completed turn logs nothing

- **GIVEN** an injected prompt that is no longer active when the threshold elapses
- **WHEN** the observation check runs
- **THEN** no log record is emitted and no request beyond the status check is made

## MODIFIED Requirements

### Requirement: kimi-server dispatcher maps HTTP failures to machine-readable error codes

The dispatcher SHALL return one of these error envelopes and NOT fall back to tmux or any other transport:

- Connection failure (fetch rejected, DNS error, ECONNREFUSED): `{ error: 'kimi_connect_failed', detail: <non-empty message>, transport_used: 'kimi-server' }`.
- Non-2xx HTTP response: `{ error: 'kimi_inject_failed', detail: { status: <status code>, body: <response body, truncated to 4KB> }, transport_used: 'kimi-server' }`. The detail.body MUST be a string; if the response body is JSON, it is serialized back to a string for inclusion.
- 2xx response whose JSON body is an error envelope with a numeric non-zero `code` field: the kimi server reports application-level failures (e.g. unknown `session_id`) as HTTP 200 with a body like `{"code":40401,"msg":"session ... does not exist",...}` instead of a non-2xx status. The dispatcher SHALL treat any 2xx response whose body parses as JSON with a numeric `code !== 0` as `{ error: 'kimi_inject_failed', detail: { status: <status code>, body: <response body, truncated to 4KB> }, transport_used: 'kimi-server' }`. A 2xx response with an empty body, a non-JSON body, or a JSON body without a numeric non-zero `code` field is a success.
- A rejection identifying the session as busy — a `SESSION_BUSY` error code or message in the response envelope, at any status — SHALL be reported as `{ error: 'kimi_session_busy', detail: { reason: 'session_busy_response' }, transport_used: 'kimi-server' }` rather than as `kimi_inject_failed`. `POST /prompts` may refuse an enqueue outright instead of queueing it, and that refusal is a deferral, not a delivery failure.

Deferral outcomes (`kimi_session_busy`, `kimi_pending_interaction`) are distinct from failure outcomes: they mean the message was not injected *yet*, and they are subject to the retry rules rather than reported as transport failures.

#### Scenario: Connection refused maps to kimi_connect_failed

- **GIVEN** target delivery is `{ kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:9999' }`
- **AND** nothing is listening on `127.0.0.1:9999`
- **WHEN** the daemon dispatches a poke
- **THEN** the dispatcher returns `{ error: 'kimi_connect_failed', detail: <string mentioning ECONNREFUSED or similar>, transport_used: 'kimi-server' }`

#### Scenario: Unknown session_id maps to kimi_inject_failed despite HTTP 200

- **GIVEN** target delivery is `{ kind: 'kimi-server', session_id: 'session_ghost', base_url: 'http://127.0.0.1:58627' }`
- **AND** the kimi server responds `200` with an error-envelope body `{"code":40401,"msg":"session session_ghost does not exist","data":null}` (the kimi server's real behavior for an unknown session)
- **WHEN** the daemon dispatches a poke
- **THEN** the dispatcher returns `{ error: 'kimi_inject_failed', detail: { status: 200, body: <string containing "does not exist"> }, transport_used: 'kimi-server' }`

#### Scenario: Non-2xx response maps to kimi_inject_failed

- **GIVEN** target delivery is `{ kind: 'kimi-server', session_id: 'session_abc', base_url: 'http://127.0.0.1:58627' }`
- **AND** the kimi server responds `500` with body `internal error`
- **WHEN** the daemon dispatches a poke
- **THEN** the dispatcher returns `{ error: 'kimi_inject_failed', detail: { status: 500, body: 'internal error' }, transport_used: 'kimi-server' }`

#### Scenario: SESSION_BUSY rejection is a deferral, not a failure

- **GIVEN** the precondition gate passed and the dispatcher issued `POST /prompts`
- **AND** the kimi server rejects the enqueue with a `SESSION_BUSY` error envelope
- **WHEN** the response is mapped
- **THEN** the dispatcher returns `{ error: 'kimi_session_busy', detail: { reason: 'session_busy_response' }, transport_used: 'kimi-server' }`
- **AND** the poke is eligible for the kimi retry gradient

#### Scenario: No tmux fallback when kimi-server dispatcher fails

- **GIVEN** target delivery is `{ kind: 'kimi-server', ... }` and the dispatcher returns `{ error: 'kimi_connect_failed', ... }`
- **WHEN** the dispatcher result is propagated by the poke dispatcher
- **THEN** the daemon MUST NOT attempt tmux paste injection as a fallback
- **AND** the poke response to the caller carries the same `kimi_connect_failed` error
