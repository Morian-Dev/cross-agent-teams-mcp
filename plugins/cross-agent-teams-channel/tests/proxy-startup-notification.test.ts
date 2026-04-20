import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createProxyServer, relayChannelWake } from '../src/proxy.js'
import { buildStartupHint } from '../src/cli.js'

describe('proxy startup channel notification', () => {
  it('emits a claude/channel notification containing csid and bind_channel instruction', async () => {
    const server = createProxyServer()
    const client = new Client({ name: 'fake-claude', version: '0.0.0' })
    const [clientT, serverT] = InMemoryTransport.createLinkedPair()

    const received: Array<{ method: string; params?: unknown }> = []
    client.fallbackNotificationHandler = async (n) => {
      received.push({ method: n.method, params: n.params })
    }

    await server.connect(serverT)
    await client.connect(clientT)

    const csid = 'csid-xyz-1234'
    // Exercise production: use the real hint builder from cli.ts
    const hint = buildStartupHint(csid)
    relayChannelWake(server, hint)

    await new Promise(r => setTimeout(r, 50))

    const hit = received.find(r => r.method === 'notifications/claude/channel')
    expect(hit, `got ${JSON.stringify(received)}`).toBeDefined()
    const params = hit!.params as { content: string; meta: Record<string, string> }
    expect(params.content).toContain(csid)
    expect(params.content).toContain('bind_channel')
    expect(params.meta.kind).toBe('startup_bind_hint')
    // Brand-contract assertions
    expect(params.content).toContain('cross-agent-teams-mcp')
    expect(params.content).not.toContain('ts-agent-teams')
    expect(params.meta.source).toBe('cross_agent_teams_mcp')

    await client.close()
    await server.close()
  })
})
