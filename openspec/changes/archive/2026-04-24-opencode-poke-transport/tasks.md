## 1. Schema and Binding

- [x] 1.1 Add nullable `opencode_base_url` and `opencode_session_id` columns to the `agents` schema and keep bootstrap or migration paths backward-compatible.
- [x] 1.2 Extend `AgentsRepo.list()` and related MCP response shapes so `list_agents` returns the new opencode transport fields.
- [x] 1.3 Implement `bind_opencode_session({base_url, session_id})` with registered-caller checks, loopback URL validation, and self-row updates.
- [x] 1.4 Register the new MCP tool in `src/mcp/tools.ts` and add unit coverage for success plus invalid base URL or blank session id failures.

## 2. Opencode Transport

- [x] 2.1 Add an opencode transport helper module that calls the official server or session prompt API and maps transport failures into classified daemon errors.
- [x] 2.2 Extend `dispatchPoke()` target lookup and result union to support `opencode-server` between Claude channel and tmux fallback.
- [x] 2.3 Update `poke()` to query opencode transport metadata and return the expanded success and failure envelopes without regressing existing validations.

## 3. Verification and Docs

- [x] 3.1 Add tests for schema columns, `list_agents` visibility, and `bind_opencode_session` persistence behavior.
- [x] 3.2 Add transport tests covering Claude-priority, opencode success, tmux fallback, and `no_transport_available` with the new `opencode_bound` detail field.
- [x] 3.3 Add error-path tests for `opencode_unreachable`, `opencode_session_not_found`, and `opencode_session_busy`.
- [x] 3.4 Update opencode-facing docs to describe the self-binding flow and how opencode poke differs from the Claude channel proxy path.
