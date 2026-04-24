#!/usr/bin/env bash
#
# launch-opencode.sh — opencode launcher that wires the xats (cross-agent-teams)
# auto-bind handshake.
#
# Pipeline:
#   1. Verify the shared opencode server is healthy (per ./start-server.sh).
#   2. Create a new session on that server via HTTP POST /session.
#   3. Read $TMUX_PANE (required — the launcher must run inside tmux).
#   4. Call `cross-agent-teams-mcp pre-register-opencode-pane` to reserve the pane.
#   5. exec opencode so the CLI runs in the same tmux pane we just pre-reg'd.
#
# NOTE on open question O1: opencode 1.14.19 has no documented "attach to
# existing server session" CLI flag (no --session / --server). This launcher
# therefore execs plain `opencode`; only the daemon-side half of the handshake
# is wired (the pre-reg row + auto-bind inside register_opencode_self). The
# interactive opencode CLI will create its own internal session that is NOT the
# same as the server session reserved for xats poke delivery. See README
# "Opencode Delivery" for the limitation.
#
# Usage:
#   ./launch-opencode.sh [--help]
#
# Environment overrides:
#   OPENCODE_BASE_URL      default http://127.0.0.1:4096
#   OPENCODE_SESSION_CREATE_PATH  default /session
#   XATS_CLI               default "cross-agent-teams-mcp"
#                           (must be on $PATH, or point at the wrapper/npm bin)
#   XATS_PORT              default 9100 (match ./start-server.sh); override if your
#                           daemon listens elsewhere. The CLI's auto-resolve reads
#                           ~/.cross-agent-teams-mcp/daemon.pid, which start-server.sh
#                           does not populate, so the launcher pins the port explicitly.
#   XATS_TOKEN             pass --token to the CLI explicitly; optional
#   OPENCODE_BIN           override the opencode binary (default: opencode)
#
# Example ~/.zshrc alias (recommended — explicit opt-in, does not shadow opencode):
#   alias free-xats-opencode='/path/to/cross-agent-teams-mcp/launch-opencode.sh'

set -euo pipefail

OPENCODE_BASE_URL="${OPENCODE_BASE_URL:-http://127.0.0.1:4096}"
OPENCODE_SESSION_CREATE_PATH="${OPENCODE_SESSION_CREATE_PATH:-/session}"
OPENCODE_HEALTH_PATH="${OPENCODE_HEALTH_PATH:-/global/health}"
XATS_CLI="${XATS_CLI:-cross-agent-teams-mcp}"
XATS_PORT="${XATS_PORT:-9100}"
OPENCODE_BIN="${OPENCODE_BIN:-opencode}"

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 0
fi

die() {
  echo "launch-opencode: $*" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v "$OPENCODE_BIN" >/dev/null 2>&1 || die "opencode binary not on PATH; set OPENCODE_BIN if needed"

# 1. Opencode server health check.
if ! curl -fsS "${OPENCODE_BASE_URL}${OPENCODE_HEALTH_PATH}" >/dev/null 2>&1; then
  die "opencode server is not healthy at ${OPENCODE_BASE_URL}${OPENCODE_HEALTH_PATH} — run ./start-server.sh first"
fi

# 2. tmux pane check (required before server session creation so we never leak
#    a dangling server session when the launcher bails out).
if [[ -z "${TMUX_PANE:-}" ]]; then
  die "TMUX_PANE is empty — wrap this launcher inside tmux (or attach to an existing tmux session) before using the xats opencode handshake"
fi

# 3. Create a server-side session via HTTP.
SESSION_JSON="$(curl -fsS -X POST "${OPENCODE_BASE_URL}${OPENCODE_SESSION_CREATE_PATH}" || true)"
if [[ -z "$SESSION_JSON" ]]; then
  die "failed to create opencode session via POST ${OPENCODE_BASE_URL}${OPENCODE_SESSION_CREATE_PATH}"
fi

SESSION_ID="$(printf '%s' "$SESSION_JSON" | node -e "
let raw=''
process.stdin.on('data', d => { raw += d })
process.stdin.on('end', () => {
  try {
    const obj = JSON.parse(raw)
    const id = obj.id || obj.session_id || (obj.session && obj.session.id)
    if (!id) { process.exit(2) }
    process.stdout.write(String(id))
  } catch (e) { process.exit(3) }
}) " || true)"

if [[ -z "$SESSION_ID" ]]; then
  die "opencode session response did not contain an id: ${SESSION_JSON}"
fi

echo "launch-opencode: created opencode session ${SESSION_ID} on ${OPENCODE_BASE_URL}"

# 4. Pre-register this pane with the xats daemon.
XATS_ARGS=(pre-register-opencode-pane --pane "$TMUX_PANE" --base-url "$OPENCODE_BASE_URL" --session-id "$SESSION_ID")
if [[ -n "${XATS_PORT:-}" ]]; then XATS_ARGS+=(--port "$XATS_PORT"); fi
if [[ -n "${XATS_TOKEN:-}" ]]; then XATS_ARGS+=(--token "$XATS_TOKEN"); fi

if ! "$XATS_CLI" "${XATS_ARGS[@]}"; then
  die "pre_register_opencode_pane call failed — is the xats daemon running?"
fi

# 5. exec opencode. See the O1 note above: no attach-to-session argv is known
#    on opencode 1.14.19, so we exec the plain binary with the user's argv.
echo "launch-opencode: exec ${OPENCODE_BIN} $* (note: opencode 1.14.19 has no --session/--server flag, so the interactive CLI starts its own session; only daemon-side poke delivery is pre-bound to ${SESSION_ID})" >&2

exec "$OPENCODE_BIN" "$@"
