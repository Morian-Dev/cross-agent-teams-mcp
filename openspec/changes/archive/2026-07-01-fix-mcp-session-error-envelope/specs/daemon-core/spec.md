## MODIFIED Requirements

### Requirement: Optional bearer token authentication

The daemon MAY be started with `--token <secret>`. When a token is configured, every MCP HTTP request MUST present it either via `Authorization: Bearer <secret>` header or a `token=<secret>` query string. Missing or mismatched tokens SHALL return HTTP 401.

The 401 response body MUST NOT be a bare `{ "error": <string> }` object. Strict MCP clients (e.g. codex's `rmcp`) deserialize any response body as a JSON-RPC message; a bare `{ "error": "invalid_token" }` object matches no JSON-RPC 2.0 variant and poisons the client transport (every subsequent call then fails with `Transport send error`). The body MUST be either an empty body (the safe default) or a well-formed JSON-RPC 2.0 error object `{ "jsonrpc": "2.0", "id": null, "error": { "code": <integer>, "message": <string> } }` that a strict client can deserialize without error. `WWW-Authenticate` MAY still be set as appropriate.

#### Scenario: No token configured (default)

- **GIVEN** daemon started without `--token`
- **WHEN** client connects without any Authorization header
- **THEN** request is accepted

#### Scenario: Token configured and matches

- **GIVEN** daemon started with `--token s3cret`
- **WHEN** client sends `Authorization: Bearer s3cret`
- **THEN** request is accepted

#### Scenario: Token configured and mismatch

- **GIVEN** daemon started with `--token s3cret`
- **WHEN** client sends `Authorization: Bearer wrong`
- **THEN** response status is 401
- **AND** the response body is NOT a bare `{ "error": "invalid_token" }` object (it is empty or a valid JSON-RPC 2.0 error object)
