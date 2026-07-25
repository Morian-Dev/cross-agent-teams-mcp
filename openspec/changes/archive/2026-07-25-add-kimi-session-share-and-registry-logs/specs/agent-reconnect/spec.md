## ADDED Requirements

### Requirement: reconnect recovers kimi-code identity by base_url and session_id

`reconnect({ agent_type: 'kimi-code', base_url, session_id })` SHALL recover a kimi-code identity, mirroring the opencode shape: reverse-look-up local agents rows whose delivery is `{ kind: 'kimi-server' }` matching the given `(base_url, session_id)` pair, and rebind the calling MCP session to the single matching identity.

`agent_type` is the explicit runtime discriminator of the base_url arm: with `agent_type='kimi-code'` the dispatch MUST be deterministic — an empty or non-matching registry returns the kimi `need_register`, never an opencode-flavored probe error. Without `agent_type`, the daemon MAY fall back to local row residency to route legacy base_url callers, but this heuristic MUST NOT be the documented path for kimi recovery (an empty registry is then indistinguishable from an opencode target).

Unlike opencode, `session_id` is REQUIRED for the kimi path: the daemon MUST NOT auto-resolve "the most recent session" for kimi, for the same reason registration refuses to guess — several kimi sessions routinely share a workDir, and binding the wrong one delivers pokes to a session nobody is watching while reporting success.

Before reusing the identity the daemon MUST revalidate the session against the kimi server: `GET <base_url>/api/v1/sessions/<session_id>` with the bearer token resolved exactly as the poke dispatcher resolves it (delivery `auth_token_ref`, else the kimi token file). A 2xx response alone is NOT sufficient: the body MUST be a strict kimi success envelope — object root with `code` exactly 0 and an object `data` (a bare 2xx JSON object without that envelope, a root-level `id`, `data: null`, or an array `data` all fail) — and the envelope MUST identify the requested session (`data.id` equal to the requested `session_id`) and MUST NOT be archived. On a missing/archived/mismatched session or a failed probe, reconnect SHALL return `session_not_found` and MUST NOT mutate any agents row or binding.

The kimi `session_id` argument only needs to be non-blank and is NORMALIZED (trimmed) at the schema layer on both register and reconnect, so registration responses, stored rows, and reconnect lookups all agree on one value — reconnect MUST NOT impose a stricter format (such as the opencode `ses` prefix) that would make a legally registered row unrecoverable. Base URLs are compared canonically on BOTH sides of the lookup — the caller's argument and the stored payload value are each passed through the shared canonicalizer — so equivalent spellings of one endpoint recover the same row, including rows persisted before canonicalization existed. A kimi `base_url` carrying a query, fragment, userinfo, or a bare trailing `?`/`#` is rejected at the schema layer, mirroring registration.

On zero matching rows, reconnect SHALL return `need_register`. On success it SHALL rebind the current connection under the recovered identity's stable runtime key (the kimi `(base_url, session_id)` pair), so the recovered connection co-exists with — rather than takes over — any live engine connection of the same session.

#### Scenario: kimi identity recovered and rebound

- **GIVEN** a local agents row `(default, kimi-1)` with delivery `{ kind: 'kimi-server', session_id: 'S', base_url: 'http://127.0.0.1:58627' }`
- **AND** the kimi server reports session `S` exists
- **WHEN** a fresh MCP session calls `reconnect({ base_url: 'http://127.0.0.1:58627', session_id: 'S' })`
- **THEN** the response carries the row's `(team, name, agent_id)`
- **AND** the calling session is bound to that `agent_id`

#### Scenario: Stale session id does not rebind

- **GIVEN** the same row, but the kimi server reports session `S` does not exist (or the probe fails)
- **WHEN** `reconnect({ base_url, session_id: 'S' })` is called
- **THEN** the response is `session_not_found`
- **AND** no agents row or binding is mutated

#### Scenario: A 2xx envelope that does not identify the session does not rebind

- **GIVEN** the same row, but the probe returns HTTP 200 with body `{}`, a root-level `{"id": "S"}` without the `{code: 0, data: {...}}` envelope, `data: null`, a session object whose `id` differs from `S`, or one with `archived: true`
- **WHEN** `reconnect({ base_url, session_id: 'S' })` is called
- **THEN** the response is `session_not_found`
- **AND** no agents row or binding is mutated

#### Scenario: No matching row asks for registration

- **GIVEN** no local `kimi-server` row matches `(base_url, session_id)` — including a completely empty registry
- **WHEN** `reconnect({ agent_type: 'kimi-code', base_url, session_id })` is called
- **THEN** the response indicates `need_register` (never an opencode-flavored probe error)

#### Scenario: session_id is required for the kimi path

- **GIVEN** a caller supplying a kimi `base_url` without `session_id` in a context where the base_url hosts kimi-server rows
- **WHEN** the daemon resolves the reconnect
- **THEN** the kimi rows are not auto-resolved by recency; recovery of a kimi identity without an explicit `session_id` is refused
