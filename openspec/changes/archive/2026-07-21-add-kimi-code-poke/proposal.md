# Proposal: add-kimi-code-poke

## Why

xats currently has native poke transports for claude-code (`claude-channel`), codex (`codex-appserver`), and opencode (`opencode-server`), but kimi-code agents can only register as `custom` and rely on tmux-poke. Kimi Code CLI ships `kimi server` — a local REST+WebSocket daemon exposing `POST /api/v1/sessions/{session_id}/prompts`, which enqueues a prompt into an existing session (verified against a live `kimi server` via its `/openapi.json`). This is structurally identical to the opencode-server transport, so kimi-code can get a first-class poke transport.

## What Changes

- Add `kimi-server` delivery kind to `DeliverySpec`: `{ kind: 'kimi-server', session_id, base_url, auth_token_ref? }`, with parse/serialize/validation support mirroring `opencode-server`.
- Add `'kimi-code'` to the `AgentType` union.
- Add a `kimi-server` poke dispatcher: `POST <base_url>/api/v1/sessions/<session_id>/prompts` with `Authorization: Bearer <resolved auth_token_ref>` and JSON body carrying the poke text; map failures to machine-readable error codes; no silent tmux fallback when the delivery kind is `kimi-server`.
- Wire the dispatcher into `dispatchPoke` for `agent_type='kimi-code'` / `delivery.kind='kimi-server'`.
- Extend the `register_agent` tool description DETECTION block with an env-based probe for kimi-code (`KIMI_XATS_BASE_URL`), mirroring the opencode `OPENCODE_XATS_BASE_URL` pattern: the launcher exports the env vars, the agent passes them explicitly into `register_agent`.
- Document the `xats-kimi` zsh launcher (yolo mode) and the `start-xats` / `stop-xats` additions for managing `kimi server` (start: `kimi server run --keep-alive`; stop: `kimi server kill`; token read from `~/.kimi-code/server.token`). The launcher is applied to the user's `~/.zshrc` as part of this change (explicitly requested by the user).

## Capabilities

### New Capabilities
- `kimi-server-transport`: kimi-server poke dispatcher (HTTP POST prompts injection, bearer auth via env-ref token, error mapping), env-based register_agent detection for kimi-code, and the `xats-kimi` / `start-xats` / `stop-xats` launcher contract.

### Modified Capabilities
- `agent-delivery`: `DeliverySpec` discriminated union gains the `kimi-server` kind; persistence and write-time validation accept it.
- `agent-registry`: `AgentType` gains `'kimi-code'`; `register_agent` accepts `agent_type='kimi-code'` with a `kimi-server` delivery.

## Impact

- `src/lib/delivery-spec.ts`, `src/lib/agent-type.ts`: union extensions.
- `src/mcp/transport-dispatch.ts`: new `dispatchKimi` branch.
- New `src/mcp/kimi-server-dispatch.ts` (+ auth helper, mirroring `opencode-server-dispatch.ts` / `opencode-auth.ts`).
- `src/mcp/tools.ts`: `register_agent` description DETECTION block gains the kimi-code probe.
- `src/storage/schema.ts`: delivery_kind values accepted at write time (no column changes — kind is a string payload).
- Tests: new unit tests mirroring the opencode-server transport test suite.
- Docs: README launcher snippet for `xats-kimi` and `start-xats`/`stop-xats` kimi-server lifecycle.
- Out-of-repo: user `~/.zshrc` gains `xats-kimi` and the `start-xats`/`stop-xats` kimi-server blocks (explicitly requested; applied after code lands).
- Open risk to verify during implementation: whether `kimi server` can drive a session that is simultaneously open in a kimi TUI (prompt queue semantics suggest yes; must be validated manually).
