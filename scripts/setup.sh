#!/bin/bash
# setup.sh — 新电脑一键安装 xats + AoE
# Usage: ./setup.sh

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

XATS_DIR="${HOME}/go/src/cross-agent-teams-mcp"
AOE_DIR="${HOME}/go/src/agent-of-empires"
GIT_USER="Morian-Dev"

echo "=== xats team setup ==="

# --- 1. Clone cross-agent-teams-mcp ---
if [ -d "$XATS_DIR" ]; then
  echo "  ${GREEN}✓${NC} cross-agent-teams-mcp exists, pulling..."
  cd "$XATS_DIR" && git pull --ff-only 2>/dev/null || true
else
  echo "  Cloning cross-agent-teams-mcp..."
  git clone "https://github.com/${GIT_USER}/cross-agent-teams-mcp.git" "$XATS_DIR"
fi
cd "$XATS_DIR" && npm install && npm run build
echo "  ${GREEN}✓${NC} cross-agent-teams-mcp ready"

# --- 2. Clone agent-of-empires ---
if [ -d "$AOE_DIR" ]; then
  echo "  ${GREEN}✓${NC} agent-of-empires exists, pulling..."
  cd "$AOE_DIR" && git pull --ff-only 2>/dev/null || true
else
  echo "  Cloning agent-of-empires..."
  git clone "https://github.com/${GIT_USER}/agent-of-empires.git" "$AOE_DIR"
fi
echo "  ${GREEN}✓${NC} agent-of-empires ready"

# --- 3. Install AoE binary ---
if command -v aoe &> /dev/null; then
  echo "  ${GREEN}✓${NC} aoe $(aoe --version 2>&1 || true)"
else
  echo "  Installing aoe..."
  cargo install --path "$AOE_DIR" 2>&1 | tail -3 || \
    cargo install --git "https://github.com/${GIT_USER}/agent-of-empires.git" 2>&1 | tail -3
fi

# --- 4. Launchd daemon ---
PLIST="${HOME}/Library/LaunchAgents/com.cross-agent-teams.daemon.plist"
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cross-agent-teams.daemon</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(which node)</string>
        <string>${XATS_DIR}/dist/cli.js</string>
        <string>daemon</string>
        <string>--port</string>
        <string>9100</string>
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
launchctl load "$PLIST" 2>/dev/null || true
echo "  ${GREEN}✓${NC} launchd installed (auto-start on login)"

# --- 5. Verify ---
sleep 2
if curl -s http://127.0.0.1:9100/health > /dev/null 2>&1; then
  echo "  ${GREEN}✓${NC} daemon running on port 9100"
else
  echo "  ${RED}✗${NC} daemon not responding — wait a moment or run: launchctl load ${PLIST}"
fi

echo ""
echo "=== Setup complete ==="
echo ""
echo "Start a team:  ${XATS_DIR}/scripts/xats-team.sh <project-dir> <team-name>"
echo ""