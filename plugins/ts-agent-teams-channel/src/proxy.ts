import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

export function createProxyServer(): McpServer {
  return new McpServer(
    { name: 'ts-agent-teams-channel', version: '0.1.0' },
    { capabilities: { experimental: { 'claude/channel': {} } } }
  )
}
