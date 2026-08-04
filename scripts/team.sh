#!/bin/bash
# team.sh — 起一个 4-agent 团队 + daemon 管理
# Usage:
#   team.sh start <project-dir> [team-name]   起团队
#   team.sh stop                              停 daemon
#   team.sh status                            查看状态

set -e

XATS_DIR="${HOME}/go/src/cross-agent-teams-mcp"
DAEMON_PORT=9100
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

daemon_running() {
  curl -s "http://127.0.0.1:${DAEMON_PORT}/health" > /dev/null 2>&1
}

cmd_start() {
  PROJECT_DIR="${1:?Usage: team.sh start <project-dir> [team-name]}"
  TEAM="${2:-$(basename "$PROJECT_DIR")}"
  SOCKET="auto-${TEAM}"
  AGENTS=("architect" "developer" "tester" "reviewer")

  # 1. Start daemon
  if daemon_running; then
    echo "daemon already running"
  else
    echo "Starting daemon..."
    cd "$XATS_DIR" && nohup node dist/cli.js daemon --port "${DAEMON_PORT}" > /tmp/xats-daemon.log 2>&1 &
    sleep 2
    if daemon_running; then
      echo "  ${GREEN}✓${NC} daemon started"
    else
      echo "  ${RED}✗${NC} daemon failed — check /tmp/xats-daemon.log"
      exit 1
    fi
  fi

  # 2. Create tmux 2x2 grid
  echo "Creating team ${TEAM}..."
  tmux -L "${SOCKET}" new-session -d -s dashboard -c "${PROJECT_DIR}"

  for i in "${!AGENTS[@]}"; do
    name="${AGENTS[$i]}"
    case $i in
      0) ;; # architect: top-left
      1) tmux -L "${SOCKET}" split-window -h -t dashboard:0 ;;
      2) tmux -L "${SOCKET}" split-window -v -t dashboard:0.0 ;;
      3) tmux -L "${SOCKET}" split-window -v -t dashboard:0.1 ;;
    esac
    pane=$i
    tmux -L "${SOCKET}" send-keys -t dashboard:0.$pane \
      "stty susp undef; exec claude" Enter
    tmux -L "${SOCKET}" select-pane -t dashboard:0.$pane -T "${name}"
  done

  tmux -L "${SOCKET}" select-layout -t dashboard:0 tiled
  tmux -L "${SOCKET}" set-option -t dashboard:0 synchronize-panes off

  echo ""
  echo "=== Team ${TEAM} ready ==="
  echo ""
  echo "Attach:  tmux -L ${SOCKET} attach -t dashboard"
  echo ""
  echo "In each pane, register:"
  echo "  [architect]  Register to xats as architect on team ${TEAM}"
  echo "  [developer]  Register to xats as developer on team ${TEAM}"
  echo "  [tester]     Register to xats as tester on team ${TEAM}"
  echo "  [reviewer]   Register to xats as reviewer on team ${TEAM}"
}

cmd_stop() {
  echo "Stopping daemon..."
  pkill -f "dist/cli.js daemon" 2>/dev/null && echo "  ${GREEN}✓${NC} daemon stopped" || echo "  daemon not running"
}

cmd_status() {
  if daemon_running; then
    echo "daemon: ${GREEN}running${NC} (port ${DAEMON_PORT})"
    curl -s "http://127.0.0.1:${DAEMON_PORT}/health" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'  sessions: {d[\"mcp_sessions\"][\"total\"]} registered, uptime: {d[\"uptime_seconds\"]}s')" 2>/dev/null || true
  else
    echo "daemon: ${RED}stopped${NC}"
  fi
  echo ""
  echo "tmux sessions:"
  found=0
  for dir in /private/tmp/tmux-501 /private/tmp/tmux-*; do
    for sock in "$dir"/*; do
      [ -S "$sock" ] || continue
      tmux -S "$sock" list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null | while IFS=' ' read -r name attached; do
        [ -z "$name" ] && continue
        [ "$attached" = "1" ] && mark=" (attached)" || mark=""
        echo "  ${name}${mark}"
      done
      found=1
    done
  done
  [ "$found" = "0" ] && echo "  none"
}

case "${1:-}" in
  start)   shift; cmd_start "$@" ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  *)
    echo "Usage: team.sh {start|stop|status}"
    echo "  start <project-dir> [team-name]  Start daemon + 4-agent team"
    echo "  stop                             Stop daemon"
    echo "  status                           Show daemon + tmux status"
    exit 1
    ;;
esac