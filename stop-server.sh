#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${LOG_DIR:-$ROOT_DIR/logs}"
PROJECT_CODEX_DIR="${PROJECT_CODEX_DIR:-$ROOT_DIR/.codex}"
GLOBAL_CODEX_DIR="${GLOBAL_CODEX_DIR:-$HOME/.codex}"

DAEMON_PID_FILE="${DAEMON_PID_FILE:-$LOG_DIR/cross-agent-teams-mcp-daemon.pid}"
APPSERVER_PID_FILE="${APPSERVER_PID_FILE:-$LOG_DIR/codex-app-server.pid}"
OPENCODE_PID_FILE="${OPENCODE_PID_FILE:-$LOG_DIR/opencode-server.pid}"

STOP_DAEMON=1
STOP_OPENCODE_SERVER=1
STOP_APP_SERVER=1
RUN_CLEANUP_CACHES=1

print_usage() {
  cat <<'EOF'
usage: ./stop-server.sh [--daemon-only] [--keep-cache]
EOF
}

for arg in "$@"; do
  case "$arg" in
    --daemon-only)
      STOP_OPENCODE_SERVER=0
      STOP_APP_SERVER=0
      RUN_CLEANUP_CACHES=0
      ;;
    --keep-cache)
      RUN_CLEANUP_CACHES=0
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

wait_for_exit() {
  local pid="$1"
  local label="$2"
  local deadline=$((SECONDS + 10))
  while kill -0 "$pid" >/dev/null 2>&1; do
    if (( SECONDS >= deadline )); then
      echo "$label did not exit after SIGTERM, sending SIGKILL"
      kill -KILL "$pid" >/dev/null 2>&1 || true
      return
    fi
    sleep 1
  done
}

stop_plain_pid_file() {
  local pid_file="$1"
  local label="$2"
  if [[ ! -f "$pid_file" ]]; then
    echo "$label is not managed by this script"
    return
  fi
  local pid
  pid="$(tr -d '[:space:]' <"$pid_file" 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    rm -f "$pid_file"
    echo "$label pid file was empty, removed"
    return
  fi
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill -TERM "$pid" >/dev/null 2>&1 || true
    wait_for_exit "$pid" "$label"
    echo "$label stopped, pid=$pid"
  else
    echo "$label pid file was stale, pid=$pid"
  fi
  rm -f "$pid_file"
}

stop_daemon_pid_file() {
  local pid_file="$1"
  local label="$2"
  if [[ ! -f "$pid_file" ]]; then
    echo "$label is not managed by this script"
    return
  fi
  local pid
  pid="$(node -e "const fs=require('fs'); try { const raw=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(String(raw.pid ?? '')); } catch { process.exit(0); }" "$pid_file" 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    rm -f "$pid_file"
    echo "$label pid file was unreadable, removed"
    return
  fi
  if kill -0 "$pid" >/dev/null 2>&1; then
    kill -TERM "$pid" >/dev/null 2>&1 || true
    wait_for_exit "$pid" "$label"
    echo "$label stopped, pid=$pid"
  else
    echo "$label pid file was stale, pid=$pid"
  fi
  rm -f "$pid_file"
}

remove_path() {
  local path="$1"
  if [[ -e "$path" ]]; then
    rm -rf "$path"
    echo "removed cache: $path"
  fi
}

cleanup_caches() {
  local paths=(
    "$LOG_DIR/cross-agent-teams-mcp-daemon.db"
    "$LOG_DIR/cross-agent-teams-mcp-daemon.db-shm"
    "$LOG_DIR/cross-agent-teams-mcp-daemon.db-wal"
    "$LOG_DIR/cross-agent-teams-mcp-daemon.log"
    "$LOG_DIR/codex-app-server.log"
    "$LOG_DIR/opencode-server.log"
    "$PROJECT_CODEX_DIR/log"
    "$PROJECT_CODEX_DIR/tmp"
    "$PROJECT_CODEX_DIR/.tmp"
    "$GLOBAL_CODEX_DIR/logs_2.sqlite"
    "$GLOBAL_CODEX_DIR/logs_2.sqlite-shm"
    "$GLOBAL_CODEX_DIR/logs_2.sqlite-wal"
    "$GLOBAL_CODEX_DIR/cache/codex_apps_tools"
  )

  local path
  for path in "${paths[@]}"; do
    remove_path "$path"
  done
}

if (( STOP_DAEMON == 1 )); then
  stop_daemon_pid_file "$DAEMON_PID_FILE" "daemon"
fi
if (( STOP_OPENCODE_SERVER == 1 )); then
  stop_plain_pid_file "$OPENCODE_PID_FILE" "opencode server"
fi
if (( STOP_APP_SERVER == 1 )); then
  stop_plain_pid_file "$APPSERVER_PID_FILE" "codex app-server"
fi
if (( RUN_CLEANUP_CACHES == 1 )); then
  cleanup_caches
fi
