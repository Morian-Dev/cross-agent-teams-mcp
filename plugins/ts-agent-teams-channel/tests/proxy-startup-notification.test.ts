import { describe, it, expect } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createProxyServer, relayChannelWake } from '../src/proxy.js'

// The proxy's startup flow (in cli.ts) runs register_agent → subscribe_channel_wake
// and then emits a host-facing notifications/claude/channel announcing the csid.
// This unit test validates the notification shape by invoking relayChannelWake
// directly with the startup-hint payload the CLI's onSequenceComplete builds.

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
    const content = [
      `ts-agent-teams: your channel_session_id is ${csid}.`,
      `Please call bind_channel({channel_session_id: "${csid}"}) to complete binding.`
    ].join(' ')
    relayChannelWake(server, {
      content,
      meta: { source: 'ts_agent_teams', kind: 'startup_bind_hint' }
    })

    // Flush the loop so InMemoryTransport delivers.
    await new Promise(r => setTimeout(r, 50))

    const hit = received.find(r => r.method === 'notifications/claude/channel')
    expect(hit, `got ${JSON.stringify(received)}`).toBeDefined()
    const params = hit!.params as { content: string; meta: Record<string, string> }
    expect(params.content).toContain(csid)
    expect(params.content).toContain('bind_channel')
    expect(params.meta.kind).toBe('startup_bind_hint')

    await client.close()
    await server.close()
  })
})
