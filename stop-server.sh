#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="${LOG_DIR:-$ROOT_DIR/logs}"

DAEMON_PID_FILE="${DAEMON_PID_FILE:-$LOG_DIR/cross-agent-teams-mcp-daemon.pid}"
APPSERVER_PID_FILE="${APPSERVER_PID_FILE:-$LOG_DIR/codex-app-server.pid}"

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

stop_daemon_pid_file "$DAEMON_PID_FILE" "daemon"
stop_plain_pid_file "$APPSERVER_PID_FILE" "codex app-server"
