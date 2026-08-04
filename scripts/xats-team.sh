#!/bin/bash
# xats-team.sh — 起一个 4-agent 团队 (architect + developer + tester + reviewer)
# Usage: xats-team.sh <project-dir> [team-name]

set -e

PROJECT_DIR="${1:?Usage: xats-team.sh <project-dir> [team-name]}"
TEAM="${2:-$(basename "$PROJECT_DIR")}"
SOCKET="auto-${TEAM}"
XATS_DIR="${HOME}/go/src/cross-agent-teams-mcp"
DAEMON_PORT=9100

AGENTS=("architect" "developer" "tester" "reviewer")

# 1. Start daemon if not running
if ! curl -s "http://127.0.0.1:${DAEMON_PORT}/health" > /dev/null 2>&1; then
  echo "Starting daemon..."
  cd "$XATS_DIR" && node dist/cli.js daemon --port "${DAEMON_PORT}" > /tmp/xats-daemon.log 2>&1 &
  sleep 2
fi

# 2. Create tmux session with 2x2 grid
echo "Creating team ${TEAM}..."
tmux -L "${SOCKET}" new-session -d -s dashboard -c "${PROJECT_DIR}"

for i in "${!AGENTS[@]}"; do
  name="${AGENTS[$i]}"
  case $i in
    0) ;; # architect: top-left, already exists
    1) tmux -L "${SOCKET}" split-window -h -t dashboard:0 ;;
    2) tmux -L "${SOCKET}" split-window -v -t dashboard:0.0 ;;
    3) tmux -L "${SOCKET}" split-window -v -t dashboard:0.1 ;;
  esac
  tmux -L "${SOCKET}" send-keys -t dashboard:0.$i \
    "stty susp undef; exec claude" Enter
  tmux -L "${SOCKET}" select-pane -t dashboard:0.$i -T "${name}"
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