#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${LOG_DIR:-$ROOT_DIR/logs}"

DAEMON_HOST="${DAEMON_HOST:-127.0.0.1}"
DAEMON_PORT="${DAEMON_PORT:-9100}"
DAEMON_PID_FILE="${DAEMON_PID_FILE:-$LOG_DIR/cross-agent-teams-mcp-daemon.pid}"
DAEMON_DB_FILE="${DAEMON_DB_FILE:-$LOG_DIR/cross-agent-teams-mcp-daemon.db}"
DAEMON_LOG_FILE="${DAEMON_LOG_FILE:-$LOG_DIR/cross-agent-teams-mcp-daemon.log}"

APPSERVER_HOST="${APPSERVER_HOST:-127.0.0.1}"
APPSERVER_PORT="${APPSERVER_PORT:-8799}"
APPSERVER_WS_URL="${APPSERVER_WS_URL:-ws://${APPSERVER_HOST}:${APPSERVER_PORT}}"
APPSERVER_HEALTH_URL="${APPSERVER_HEALTH_URL:-http://${APPSERVER_HOST}:${APPSERVER_PORT}/healthz}"
APPSERVER_PID_FILE="${APPSERVER_PID_FILE:-$LOG_DIR/codex-app-server.pid}"
APPSERVER_LOG_FILE="${APPSERVER_LOG_FILE:-$LOG_DIR/codex-app-server.log}"

OPENCODE_HOST="${OPENCODE_HOST:-127.0.0.1}"
OPENCODE_PORT="${OPENCODE_PORT:-4096}"
OPENCODE_URL="${OPENCODE_URL:-http://${OPENCODE_HOST}:${OPENCODE_PORT}}"
OPENCODE_HEALTH_URL="${OPENCODE_HEALTH_URL:-http://${OPENCODE_HOST}:${OPENCODE_PORT}/global/health}"
OPENCODE_PID_FILE="${OPENCODE_PID_FILE:-$LOG_DIR/opencode-server.pid}"
OPENCODE_LOG_FILE="${OPENCODE_LOG_FILE:-$LOG_DIR/opencode-server.log}"

WAIT_TIMEOUT_SECONDS="${WAIT_TIMEOUT_SECONDS:-20}"

RUN_APP_SERVER=1
RUN_OPENCODE_SERVER=1

print_usage() {
  cat <<'EOF'
usage: ./start-server.sh [--daemon-only] [--skip-app-server] [--skip-opencode-server]
EOF
}

for arg in "$@"; do
  case "$arg" in
    --daemon-only)
      RUN_APP_SERVER=0
      RUN_OPENCODE_SERVER=0
      ;;
    --skip-app-server)
      RUN_APP_SERVER=0
      ;;
    --skip-opencode-server)
      RUN_OPENCODE_SERVER=0
      ;;
    --help|-h)
      print_usage
      exit 0
      ;;
    *)
      echo "unknown argument: $arg" >&2
      print_usage >&2
      exit 2
      ;;
  esac
done

mkdir -p "$LOG_DIR"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing command: $1" >&2
    exit 1
  fi
}

cleanup_plain_pid_file() {
  local pid_file="$1"
  if [[ ! -f "$pid_file" ]]; then
    return
  fi
  local pid
  pid="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    rm -f "$pid_file"
    return
  fi
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    rm -f "$pid_file"
  fi
}

cleanup_daemon_pid_file() {
  local pid_file="$1"
  if [[ ! -f "$pid_file" ]]; then
    return
  fi
  local pid
  pid="$(node -e "const fs=require('fs'); try { const raw=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(String(raw.pid ?? '')); } catch { process.exit(0); }" "$pid_file" 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    rm -f "$pid_file"
    return
  fi
  if ! kill -0 "$pid" >/dev/null 2>&1; then
    rm -f "$pid_file"
  fi
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local deadline
  deadline=$((SECONDS + WAIT_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "$label did not become healthy within ${WAIT_TIMEOUT_SECONDS}s: $url" >&2
  return 1
}

read_daemon_port() {
  node -e "const fs=require('fs'); const raw=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(String(raw.port));" "$1"
}

read_daemon_pid() {
  node -e "const fs=require('fs'); const raw=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(String(raw.pid));" "$1"
}

print_health_summary() {
  local daemon_port daemon_health_url daemon_health_body
  daemon_port="$(read_daemon_port "$DAEMON_PID_FILE")"
  daemon_health_url="http://${DAEMON_HOST}:${daemon_port}/health"
  daemon_health_body="$(curl -fsS "$daemon_health_url")"

  echo "health check passed"
  if (( RUN_APP_SERVER == 1 )); then
    local app_health_body
    app_health_body="$(curl -fsS "$APPSERVER_HEALTH_URL")"
    echo "  codex app-server: $APPSERVER_HEALTH_URL"
    echo "  response: $app_health_body"
  fi
  if (( RUN_OPENCODE_SERVER == 1 )); then
    local opencode_health_body
    opencode_health_body="$(curl -fsS "$OPENCODE_HEALTH_URL")"
    echo "  opencode server: $OPENCODE_HEALTH_URL"
    echo "  response: $opencode_health_body"
  fi
  echo "  daemon: $daemon_health_url"
  echo "  response: $daemon_health_body"
  echo "server startup succeeded"
}

start_app_server() {
  cleanup_plain_pid_file "$APPSERVER_PID_FILE"

  if curl -fsS "$APPSERVER_HEALTH_URL" >/dev/null 2>&1; then
    echo "codex app-server already healthy at $APPSERVER_WS_URL"
    return 0
  fi

  : >"$APPSERVER_LOG_FILE"
  nohup codex app-server --listen "$APPSERVER_WS_URL" >>"$APPSERVER_LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$APPSERVER_PID_FILE"

  if ! wait_for_http "$APPSERVER_HEALTH_URL" "codex app-server"; then
    kill "$pid" >/dev/null 2>&1 || true
    rm -f "$APPSERVER_PID_FILE"
    echo "codex app-server log:" >&2
    tail -n 50 "$APPSERVER_LOG_FILE" >&2 || true
    return 1
  fi

  echo "codex app-server started in background, pid=$pid, ws=$APPSERVER_WS_URL"
}

start_opencode_server() {
  cleanup_plain_pid_file "$OPENCODE_PID_FILE"

  if curl -fsS "$OPENCODE_HEALTH_URL" >/dev/null 2>&1; then
    echo "opencode server already healthy at $OPENCODE_URL"
    return 0
  fi

  : >"$OPENCODE_LOG_FILE"
  nohup opencode serve --port "$OPENCODE_PORT" --hostname "$OPENCODE_HOST" >>"$OPENCODE_LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$OPENCODE_PID_FILE"

  if ! wait_for_http "$OPENCODE_HEALTH_URL" "opencode server"; then
    kill "$pid" >/dev/null 2>&1 || true
    rm -f "$OPENCODE_PID_FILE"
    echo "opencode server log:" >&2
    tail -n 50 "$OPENCODE_LOG_FILE" >&2 || true
    return 1
  fi

  echo "opencode server started in background, pid=$pid, url=$OPENCODE_URL"
}

start_daemon() {
  cleanup_daemon_pid_file "$DAEMON_PID_FILE"

  if [[ -f "$DAEMON_PID_FILE" ]]; then
    local pid port
    pid="$(read_daemon_pid "$DAEMON_PID_FILE")"
    port="$(read_daemon_port "$DAEMON_PID_FILE")"
    if kill -0 "$pid" >/dev/null 2>&1; then
      echo "daemon already running, pid=$pid, url=http://${DAEMON_HOST}:${port}/mcp"
      return 0
    fi
    rm -f "$DAEMON_PID_FILE"
  fi

  : >"$DAEMON_LOG_FILE"
  nohup node "$ROOT_DIR/dist/cli.js" daemon \
    --port "$DAEMON_PORT" \
    --pid-file "$DAEMON_PID_FILE" \
    --db "$DAEMON_DB_FILE" \
    >>"$DAEMON_LOG_FILE" 2>&1 &

  local deadline
  deadline=$((SECONDS + WAIT_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    if [[ -f "$DAEMON_PID_FILE" ]]; then
      break
    fi
    sleep 1
  done

  if [[ ! -f "$DAEMON_PID_FILE" ]]; then
    echo "daemon pid file was not created: $DAEMON_PID_FILE" >&2
    echo "daemon log:" >&2
    tail -n 50 "$DAEMON_LOG_FILE" >&2 || true
    return 1
  fi

  local port pid
  port="$(read_daemon_port "$DAEMON_PID_FILE")"
  pid="$(read_daemon_pid "$DAEMON_PID_FILE")"
  local health_url="http://${DAEMON_HOST}:${port}/health"
  if ! wait_for_http "$health_url" "daemon"; then
    kill "$pid" >/dev/null 2>&1 || true
    rm -f "$DAEMON_PID_FILE"
    echo "daemon log:" >&2
    tail -n 50 "$DAEMON_LOG_FILE" >&2 || true
    return 1
  fi

  echo "daemon started in background, pid=$pid, url=http://${DAEMON_HOST}:${port}/mcp"
}

require_cmd codex
require_cmd node
require_cmd curl
require_cmd pnpm

echo "building project with pnpm build"
(
  cd "$ROOT_DIR"
  pnpm build
)

if (( RUN_APP_SERVER == 1 )); then
  start_app_server
fi
if (( RUN_OPENCODE_SERVER == 1 )); then
  start_opencode_server
fi
start_daemon
print_health_summary

echo "logs directory: $LOG_DIR"
