## Why

opencode is currently a second-class xats client: it routes through the generic tmux paste/Enter path (fallback of `dispatchUnknown`) with no native delivery transport, after the previous `opencode-server` HTTP transport was deleted in 2026-04-30 because it depended on opencode self-identifying inside its own MCP session (which its runtime could not do reliably). Meanwhile opencode ships a first-class headless HTTP API (`POST /session/{id}/prompt_async`) that is a near-perfect mirror of the existing Codex `turn/start` flow, and exposes a TUI-co-located HTTP server when launched with an explicit `--port`. The blocker was never the API surface — it was identity discovery. A launcher that injects `OPENCODE_XATS_BASE_URL` into opencode's environment dissolves that blocker: the agent reads the env via its Bash tool and explicitly passes the value into `register_agent`, no self-identification required.

## What Changes

- **Add `agent_type='opencode'`** as a new enum value in `register_agent` (parallel to `'claude-code'` and `'codex'`), with a new DETECTION rule keyed on `printenv OPENCODE_XATS_BASE_URL` non-empty.
- **Add `delivery.kind='opencode-server'`** to `DeliverySpec`, persisting `{session_id, base_url, auth_token_ref?}` (parallel to `codex-appserver`'s `{thread_id, ws_url, auth_token_ref?}`).
- **New `opencode-server-dispatch.ts`** HTTP dispatcher: `POST <base_url>/session/<sid>/prompt_async` with body `{parts:[{type:'text', text}], noReply:true}`. Returns `{ok:true, transport_used:'opencode-server', session_id}` on HTTP 204.
- **Extend `register_agent({agent_type:'opencode', base_url})`**: when `session_id` is omitted, daemon resolves it as the most recently `time_updated` session on that base_url (mirrors codex `thread_id_required` fallback, but auto-selects rather than asking the agent to pick).
- **Extend `transport-dispatch.ts`** with a `'opencode-server'` branch routing to the new dispatcher. **No tmux fallback** (parallel to codex-appserver).
- **New `free-xats-opencode` zsh function** (documented; not shipped in repo): finds an idle localhost port, exports `OPENCODE_XATS_BASE_URL=http://127.0.0.1:<port>`, then `exec opencode --port <port> --hostname 127.0.0.1`. Replaces the deleted `launch-opencode.sh`.
- **Delete `openspec/changes/archive/2026-04-30-drop-opencode-server-transport/`**: that change's rationale (opencode cannot self-identify) is dissolved by the launcher-injected env approach; leaving the archived "drop" change in place would mislead future readers about the current design.

## Capabilities

### New Capabilities
- `opencode-server-transport`: HTTP transport delivering poke prompts to an opencode session via `POST /session/{id}/prompt_async`. Covers dispatcher protocol, error mapping, and endpoint reachability contract.

### Modified Capabilities
- `agent-delivery`: extends `DeliverySpec` discriminated union with a fourth kind `'opencode-server'`; persistence + validation + write validator + dispatch routing rules updated accordingly.
- `agent-registry`: `register_agent` accepts new `agent_type='opencode'` and a conditionally-required `base_url` field; daemon resolves `session_id` by querying the target base_url when the caller omits it; tool description gains a new DETECTION rule keyed on `OPENCODE_XATS_BASE_URL`.

## Impact

- **Code**: `src/lib/delivery-spec.ts` (kind enum, validators, parsers, serializers), new `src/mcp/opencode-server-dispatch.ts`, `src/mcp/register-agent.ts` (new agent_type branch + session_id auto-resolution), `src/mcp/tools.ts` (input schema, description DETECTION section), `src/mcp/transport-dispatch.ts` (route branch).
- **Schema**: `delivery_kind` column already accepts any string; no DB migration. Existing `'opencode'` ClientKind label and `agent_type` enum gain a real dispatch target.
- **Public MCP surface**: `register_agent` input schema gains `base_url?: string` (opencode-only). No new top-level tool.
- **Launcher surface**: README documents the new `free-xats-opencode` zsh function. Users replace plain `opencode` with it.
- **Archive cleanup**: deletion of `openspec/changes/archive/2026-04-30-drop-opencode-server-transport/` (proposal + design + tasks + specs). No production code touched by the deletion.
- **Dependencies**: no new runtime dependencies. Uses Node built-in `fetch` for HTTP.
