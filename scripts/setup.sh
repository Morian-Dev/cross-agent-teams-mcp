#!/bin/bash
# xats-setup — bootstrap cross-agent-teams + AoE on a new machine
# Usage: curl -sL <url> | bash   OR   ./xats-setup.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

echo "=== xats cross-agent-teams setup ==="

# --- config ---
REPO_DIR="${HOME}/go/src/cross-agent-teams-mcp"
DAEMON_PORT=9100
PLIST_PATH="${HOME}/Library/LaunchAgents/com.cross-agent-teams.daemon.plist"

# --- 1. Clone & build cross-agent-teams-mcp ---
if [ -d "$REPO_DIR" ]; then
  echo "  ${GREEN}✓${NC} cross-agent-teams-mcp already cloned"
  cd "$REPO_DIR" && git pull --ff-only 2>/dev/null || true
else
  echo "  Cloning cross-agent-teams-mcp..."
  git clone git@github.com:Morian-Dev/cross-agent-teams-mcp.git "$REPO_DIR" 2>/dev/null || \
    git clone https://github.com/Morian-Dev/cross-agent-teams-mcp.git "$REPO_DIR"
fi

cd "$REPO_DIR"
npm install --production 2>&1 | tail -1
npm run build 2>&1 | tail -1
echo "  ${GREEN}✓${NC} cross-agent-teams-mcp built"

# --- 2. Install launchd agent ---
mkdir -p "$(dirname "$PLIST_PATH")"
cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cross-agent-teams.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which node)</string>
        <string>${REPO_DIR}/dist/cli.js</string>
        <string>daemon</string>
        <string>--port</string>
        <string>${DAEMON_PORT}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/xats-daemon.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/xats-daemon.err</string>
</dict>
</plist>
PLIST
launchctl load "$PLIST_PATH" 2>/dev/null || true
echo "  ${GREEN}✓${NC} launchd agent installed (auto-start on login)"

# --- 3. Install AoE ---
if command -v aoe &> /dev/null; then
  echo "  ${GREEN}✓${NC} AoE already installed ($(aoe --version 2>&1 || echo 'ok'))"
else
  echo "  Installing AoE..."
  cargo install --git https://github.com/njbrake/agent-of-empires.git 2>&1 | tail -1 || \
    echo "  ${RED}✗${NC} AoE install failed — install manually: cargo install --git https://github.com/njbrake/agent-of-empires.git"
fi

# --- 4. Set up Claude Code config ---
mkdir -p "${HOME}/.claude"
SETTINGS="${HOME}/.claude/settings.json"
if [ -f "$SETTINGS" ]; then
  # Add xats permissions if not present
  if ! grep -q "mcp__cross-agent-teams" "$SETTINGS" 2>/dev/null; then
    echo "  Add 'mcp__cross-agent-teams__*' to ${SETTINGS} permissions"
  fi
  echo "  ${GREEN}✓${NC} Claude Code settings exist"
else
  echo "  ${RED}✗${NC} No Claude Code settings found — configure manually"
fi

# --- 5. Verify ---
sleep 2
if curl -s "http://127.0.0.1:${DAEMON_PORT}/health" > /dev/null 2>&1; then
  echo "  ${GREEN}✓${NC} daemon running on port ${DAEMON_PORT}"
else
  echo "  ${RED}✗${NC} daemon not responding — start manually: cd ${REPO_DIR} && node dist/cli.js daemon --port ${DAEMON_PORT}"
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "New project?  Run:  ${REPO_DIR}/scripts/xats-team.sh <project-dir> <team-name>"
echo "Dashboard:    tmux -L auto-<team>-* attach -t dashboard"
echo ""