#!/bin/bash
# setup.sh — 新电脑一键安装 xats + AoE（克隆 + 编译）
# Usage: ./setup.sh

set -e

GREEN='\033[0;32m'
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

echo ""
echo "=== Setup complete ==="
echo ""
echo "Start a team:  ${XATS_DIR}/scripts/team.sh <project-dir> <team-name>"