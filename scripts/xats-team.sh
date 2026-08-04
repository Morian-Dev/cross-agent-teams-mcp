#!/bin/bash
# xats-team — launch a 4-agent team (architect, developer, tester, reviewer)
# Usage: xats-team <project-dir> [team-name]
#
# Example: xats-team ~/go/src/myproject myproject

set -e

PROJECT_DIR="${1:?Usage: xats-team <project-dir> [team-name]}"
TEAM="${2:-$(basename "$PROJECT_DIR")}"
SOCKET_NAME="auto-${TEAM}-$(uuidgen | cut -c1-4)"
SOCK="/private/tmp/tmux-501/${SOCKET_NAME}"
DAEMON_PORT=9100
CHANNEL="server:cross-agent-teams-channel"

AGENTS=("architect" "developer" "tester" "reviewer")

# 1. Ensure xats daemon is running
if ! curl -s "http://127.0.0.1:${DAEMON_PORT}/health" > /dev/null 2>&1; then
  echo "Starting xats daemon..."
  cd ~/go/src/cross-agent-teams-mcp
  nohup node dist/cli.js daemon --port "${DAEMON_PORT}" > /tmp/xats-daemon.log 2>&1 &
  sleep 2
fi

# 2. Create tmux socket
echo "Creating tmux session for team ${TEAM}..."
tmux -L "${SOCKET_NAME}" new-session -d -s "dashboard" -c "${PROJECT_DIR}"

# 3. Create 4 agent panes in 2x2 grid
for i in "${!AGENTS[@]}"; do
  name="${AGENTS[$i]}"
  if [ "$i" -eq 0 ]; then
    # First pane: architect (top-left, already exists)
    tmux -L "${SOCKET_NAME}" send-keys -t dashboard:0 \
      "AOE_INSTANCE_ID='$(uuidgen | tr -d -)' claude --session-id $(uuidgen)" Enter
  else
    # Create split
    case $i in
      1) tmux -L "${SOCKET_NAME}" split-window -h -t dashboard:0 ;;
      2) tmux -L "${SOCKET_NAME}" split-window -v -t dashboard:0.0 ;;
      3) tmux -L "${SOCKET_NAME}" split-window -v -t dashboard:0.1 ;;
    esac
    pane=$((i))
    tmux -L "${SOCKET_NAME}" send-keys -t dashboard:0.$pane \
      "AOE_INSTANCE_ID='$(uuidgen | tr -d -)' claude --session-id $(uuidgen)" Enter
  fi
  # Set pane title
  tmux -L "${SOCKET_NAME}" select-pane -t dashboard:0.$pane -T "${name}" 2>/dev/null || true
done

tmux -L "${SOCKET_NAME}" select-layout -t dashboard:0 tiled
tmux -L "${SOCKET_NAME}" set-option -t dashboard:0 synchronize-panes off

echo ""
echo "=== Team ${TEAM} ready ==="
echo "Attach:  tmux -L ${SOCKET_NAME} attach -t dashboard"
echo ""
echo "In each pane, register the agent:"
echo "  architect: Register to xats as architect on team ${TEAM}"
echo "  developer: Register to xats as developer on team ${TEAM}"
echo "  tester:    Register to xats as tester on team ${TEAM}"
echo "  reviewer:  Register to xats as reviewer on team ${TEAM}"