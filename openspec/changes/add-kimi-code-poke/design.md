# Design: add-kimi-code-poke

## Context

xats has three native poke transports: `claude-channel` (MCP notification fanout), `codex-appserver` (WebSocket thread/resume), and `opencode-server` (HTTP `prompt_async`). kimi-code agents currently register as `custom` and fall back to tmux-poke only.

Verified facts about Kimi Code (from official docs + live probing of `kimi server` on this machine):

- `kimi web --no-open` starts a local REST+WebSocket daemon (default port 58627, loopback-only, bearer auth). OpenAPI at `/openapi.json`. It runs in the foreground, so callers background it. (The original `kimi server run` spelling was deprecated to a no-op stub in kimi 0.28.0; `kimi web kill` / `kimi web ps` / `kimi web rotate-token` replace the old lifecycle subcommands.)
- `POST /api/v1/sessions/{session_id}/prompts` with body `{ content: [{ type: 'text', text }] }` submits a prompt into an existing session's prompt queue (active/queued/blocked) — this is the poke injection point, structurally identical to opencode's `prompt_async`.
- The bearer token is persisted by kimi itself at `~/.kimi-code/server.token` and is stable across server restarts.
- Kimi Code does NOT inject a session-id env var into MCP subprocesses, and there is no "who am I" REST endpoint. Sessions are listed in `~/.kimi-code/session_index.jsonl` (JSONL, each line `{sessionId, sessionDir, workDir, ...}`).
- The 0.27-era 60s idle-exit (which `--keep-alive` existed to suppress) is gone as of 0.28.0: `kimi web` has no `--keep-alive` flag and stays up with no connected clients.

Existing opencode-server transport (`src/mcp/opencode-server-dispatch.ts`, `src/lib/delivery-spec.ts`, `src/mcp/transport-dispatch.ts`, `openspec/specs/opencode-server-transport/spec.md`) is the direct template for every piece of this change.

## Goals / Non-Goals

**Goals:**
- New `kimi-server` delivery kind + `kimi-code` agent type, wired end-to-end (register → persist → poke dispatch).
- Env-opt-in self-identification via `KIMI_XATS_BASE_URL`, mirroring the opencode launcher pattern.
- `xats-kimi` (yolo) launcher + `start-xats`/`stop-xats` kimi-server lifecycle, applied to `~/.zshrc`.

**Non-Goals:**
- No `kimi acp` or `notifications`-based transport (ACP is a separate subprocess protocol; kimi MCP client has no documented server→client notification injection).
- No daemon-side `session_id` auto-resolution (kimi has no sound "most recent session" semantic from inside a session).
- No WebSocket usage; a single REST POST per poke is sufficient.
- No changes to kimi-code itself.

## Decisions

### D1: Delivery shape mirrors opencode-server

`{ kind: 'kimi-server', session_id, base_url, auth_token_ref? }` added to `DeliverySpec`, `AgentType` gains `'kimi-code'`. Reuses the same persistence columns (`delivery_kind`/`delivery_payload` — plain strings, no migration needed) and the same write/read validation structure. Unlike opencode, `session_id` has NO prefix constraint (`session_<uuid>` and ULID-style ids both exist in the wild).

### D2: Dispatch = single POST to /prompts, no health pre-check

`dispatchKimiServerPoke` POSTs `{ content: [{ type: 'text', text }] }` to `<base_url>/api/v1/sessions/<session_id>/prompts`. 2xx → ok — except that the kimi server reports application-level failures (e.g. unknown session_id) as HTTP 200 with an error envelope `{"code":40401,"msg":"...","data":null}` (confirmed by live probing; its OpenAPI declares `code: 0` as the success enum), so a 2xx body that parses as JSON with a numeric non-zero `code` is also mapped to `kimi_inject_failed { status, body≤4KB }`. Non-2xx → `kimi_inject_failed { status, body≤4KB }`. Fetch rejection → `kimi_connect_failed`. No tmux fallback (same rule as opencode). No registration-time health check: `start-xats` may start the kimi server after agents register; reachability is a poke-time concern. (The opencode branch health-checks at register because it auto-resolves session_id over HTTP; kimi does no HTTP at register.)

### D3: Token resolution — env-ref first, then ~/.kimi-code/server.token

kimi persists its server token at `~/.kimi-code/server.token`, stable across restarts. Dispatch order: (1) `auth_token_ref` present → resolve as env var name (missing/empty → `missing_auth_token` before any I/O, same as opencode); (2) absent → read the token file (missing/empty → `missing_auth_token`). This keeps zero-config for the common local case while preserving the env-ref escape hatch for non-default setups. Alternatives considered: requiring `auth_token_ref` always (extra launcher plumbing for no security gain — the file is already user-only) and daemon flag `--kimi-token` (more config surface than needed).

### D4: session_id is REQUIRED at register; the launcher pre-creates the session and exports KIMI_XATS_SESSION_ID

The kimi session cannot learn its own id from its environment. The original design had the agent derive it from `~/.kimi-code/session_index.jsonl` (last `workDir`-matching line) — this FAILED in live testing (2026-07-20): with several kimi sessions in one directory, a newer unrelated session wins the "last line" race, registration binds the wrong session_id, and pokes are delivered to that session (which wakes and even answers mail) while the TUI the user watches never reacts.

The revised mechanism: `xats-kimi` pre-creates the session via `POST /api/v1/sessions` (exact id, correct `metadata.cwd`), sets its model AND `permission_mode: "yolo"` via `POST /api/v1/sessions/<id>/profile` (server-created sessions carry no model — every server-driven turn fails instantly with `model.not_configured`, discovered live 2026-07-20; and server-driven turns use the session's permission mode, not the CLI's `--yolo` flag — without it poke-woken turns block on unanswered tool approvals, also discovered live), fires one trivial init prompt to materialize the session's `agents/` state (the CLI refuses to attach a server-created session without it — `Agent "main" was not found`), then exports `KIMI_XATS_SESSION_ID` and launches `kimi --session <id>`. Verified end-to-end on kimi 0.27.0: REST create → profile set → init prompt → `kimi --session <id>` attaches and runs; pokes to such a session complete their turns (`prompt.completed reason=completed`). Alternatives considered: session_index derivation (proven unsound, see above) and daemon-side auto-resolution à la opencode (unsound for kimi — the kimi server is a global singleton hosting all workspaces/sessions, unlike opencode's per-instance dedicated port, so "most recently updated" can be another agent's session).

### D5: Launcher + lifecycle in ~/.zshrc

- `xats-kimi`: base_url = `${KIMI_XATS_BASE_URL:-http://127.0.0.1:58627}`; if port not listening, `kimi web --no-open` (backgrounded) and wait; pre-create the session via `POST /api/v1/sessions` (token from `~/.kimi-code/server.token`), fire an init prompt and wait for `agents/main`; then `KIMI_XATS_BASE_URL=... KIMI_XATS_SESSION_ID=... exec kimi --session <id> --yolo "$@"`. Yolo-only per user request (mirrors `free-xats-opencode`).
- `start-xats`: after the existing daemon/codex blocks, if `kimi` binary exists and port 58627 is free, `kimi web --no-open` backgrounded (logged via `_xats-log-event`); skip silently when binary absent.
- `stop-xats`: `kimi web kill` after daemon stop, with lsof/kill fallback on port 58627.

These are documented contracts in specs + README, then applied to the user's `~/.zshrc` (explicitly requested; file lives outside the repo).

## Risks / Trade-offs

- [TUI + server driving the same session concurrently may conflict] → Mitigation: the /prompts queue is the kimi web UI's own mechanism, so concurrent attachment is a supported product path; still validated manually after implementation (send a poke to a TUI-open session and observe). If it fails, fallback is tmux-poke via `custom` registration — no regression vs today.
- [Wrong session_id when multiple kimi sessions share a workDir] → Accepted (D4); agent can re-register with a corrected id.
- [Token file path changes in a future kimi version] → Mitigation: `auth_token_ref` env-ref override remains available; single constant to update.
- [kimi server not running at poke time] → Surfaced as `kimi_connect_failed`; mailbox auto-poke retry governs, same as opencode.

## Migration Plan

Purely additive: new union members, new dispatcher, new description text. No DB migration (delivery_kind is a free string column). Existing `custom`-registered kimi agents keep working via tmux-poke until they re-register as `kimi-code`.

## Open Questions

- None blocking. (TUI/server concurrency behavior is a validation item, not a design fork.)
