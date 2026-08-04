#!/bin/bash
# team.sh — 起 agent 团队 + daemon 管理
# Usage:
#   team.sh new    <project-dir> [team-name] [agent1 agent2 ...]  新建对话
#   team.sh resume <project-dir> [team-name]                      恢复对话
#   team.sh stop                                                   停 daemon
#   team.sh status                                                 查看状态

set -e

XATS_DIR="${HOME}/go/src/cross-agent-teams-mcp"
DAEMON_PORT=9100
GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

daemon_running() {
  curl -s "http://127.0.0.1:${DAEMON_PORT}/health" > /dev/null 2>&1
}

ensure_daemon() {
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
}

# $1=socket $2=project-dir $3=claude-flag $4+=agents
# CLAUDE_FLAG: "" for new session, "--session-id <name>-<team>" for resume
create_tmux_grid() {
  local SOCKET="$1" PROJECT_DIR="$2"
  shift 2
  local AGENTS=("$@")

  tmux -L "${SOCKET}" new-session -d -s dashboard -c "${PROJECT_DIR}"

  for i in "${!AGENTS[@]}"; do
    local entry="${AGENTS[$i]}"
    # entry is either "name" (new) or "name:flag" (resume)
    local name="${entry%%:*}"
    local flag="${entry#*:}"
    [ "$flag" = "$name" ] && flag=""

    case $i in
      0) ;; # first: top-left
      1) tmux -L "${SOCKET}" split-window -h -t dashboard:0 ;;
      2) tmux -L "${SOCKET}" split-window -v -t dashboard:0.0 ;;
      3) tmux -L "${SOCKET}" split-window -v -t dashboard:0.1 ;;
      *) tmux -L "${SOCKET}" split-window -t dashboard:0 ;;
    esac
    tmux -L "${SOCKET}" send-keys -t dashboard:0.$i \
      "stty susp undef; exec claude ${flag}" Enter
    tmux -L "${SOCKET}" select-pane -t dashboard:0.$i -T "${name}"
  done

  tmux -L "${SOCKET}" select-layout -t dashboard:0 tiled
  tmux -L "${SOCKET}" set-option -t dashboard:0 synchronize-panes off
}

cmd_new() {
  local PROJECT_DIR="${1:?Usage: team.sh new <project-dir> [team-name] [agent1 agent2 ...]}"
  local TEAM="${2:-$(basename "$PROJECT_DIR")}"
  local SOCKET="auto-${TEAM}"
  shift 2
  local AGENTS=("${@}")
  [ ${#AGENTS[@]} -eq 0 ] && AGENTS=("architect" "developer" "tester" "reviewer")

  ensure_daemon

  if tmux -L "${SOCKET}" has-session -t dashboard 2>/dev/null; then
    echo "  ${RED}✗${NC} Team ${TEAM} already exists."
    echo "  Use 'team.sh resume' or: tmux -L ${SOCKET} attach -t dashboard"
    exit 1
  fi

  echo "Creating team ${TEAM} (NEW) with ${#AGENTS[@]} agents: ${AGENTS[*]}..."
  create_tmux_grid "$SOCKET" "$PROJECT_DIR" "${AGENTS[@]}"

  print_ready "$SOCKET" "$TEAM" "${AGENTS[@]}"
}

cmd_resume() {
  local PROJECT_DIR="${1:?Usage: team.sh resume <project-dir> [team-name]}"
  local TEAM="${2:-$(basename "$PROJECT_DIR")}"
  local SOCKET="auto-${TEAM}"

  ensure_daemon

  if tmux -L "${SOCKET}" has-session -t dashboard 2>/dev/null; then
    echo "Team ${TEAM} already running."
    echo "Attach:  tmux -L ${SOCKET} attach -t dashboard"
    return
  fi

  # Detect which agents were previously registered
  local AGENTS=()
  local db="${HOME}/.cross-agent-teams-mcp/data.db"
  if [ -f "$db" ]; then
    while IFS= read -r name; do
      [ -n "$name" ] && AGENTS+=("${name}:--session-id ${name}-${TEAM}")
    done < <(sqlite3 "$db" "SELECT DISTINCT name FROM agents WHERE team='${TEAM}' AND role != '__channel_proxy__' ORDER BY name" 2>/dev/null || true)
  fi
  [ ${#AGENTS[@]} -eq 0 ] && AGENTS=("architect:--session-id architect-${TEAM}" "developer:--session-id developer-${TEAM}" "tester:--session-id tester-${TEAM}" "reviewer:--session-id reviewer-${TEAM}")

  echo "Resuming team ${TEAM} with ${#AGENTS[@]} agents..."
  create_tmux_grid "$SOCKET" "$PROJECT_DIR" "${AGENTS[@]}"

  print_ready "$SOCKET" "$TEAM" "${AGENTS[@]}"
}

print_ready() {
  local SOCKET="$1" TEAM="$2"
  shift 2
  local AGENTS=("$@")

  echo ""
  echo "=== Team ${TEAM} ready ==="
  echo ""
  echo "Attach:  tmux -L ${SOCKET} attach -t dashboard"
  echo ""
  echo "In each pane, reconnect:"
  for entry in "${AGENTS[@]}"; do
    local name="${entry%%:*}"
    echo "  [${name}]  Register to xats as ${name} on team ${TEAM}"
  done
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
  local found=0
  for sock in /private/tmp/tmux-$(id -u)/*; do
    [ -S "$sock" ] || continue
    tmux -S "$sock" list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null | while IFS=' ' read -r name attached; do
      [ -z "$name" ] && continue
      [ "$attached" = "1" ] && mark=" (attached)" || mark=""
      echo "  ${name}${mark}"
    done
    found=1
  done
  [ "$found" = "0" ] && echo "  none"
}

case "${1:-}" in
  new)     shift; cmd_new "$@" ;;
  resume)  shift; cmd_resume "$@" ;;
  stop)    cmd_stop ;;
  status)  cmd_status ;;
  *)
    echo "Usage: team.sh {new|resume|stop|status}"
    echo ""
    echo "  new    <project-dir> [team] [agents...]   新建对话（全新 session）"
    echo "  resume <project-dir> [team]                恢复对话（关机后回来）"
    echo "  stop                                       停 daemon"
    echo "  status                                     查看状态"
    echo ""
    echo "Examples:"
    echo "  team.sh new    ~/proj myteam                              # 默认 4 agent"
    echo "  team.sh new    ~/proj myteam architect coder qa           # 自定义 3 agent"
    echo "  team.sh resume ~/proj myteam                              # 恢复之前的对话"
    exit 1
    ;;
esac