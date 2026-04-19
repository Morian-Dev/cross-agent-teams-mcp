import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

function parseTool(res: unknown): any {
  const r = res as { content: Array<{ type: string; text: string }> }
  return JSON.parse(r.content[0].text)
}

const ContractEventNotificationSchema = z.object({
  method: z.literal('notifications/contract_event'),
  params: z.object({
    type: z.literal('contract_event'),
    event_id: z.number(),
    contract_name: z.string(),
    version: z.number(),
    diff: z.unknown().nullable()
  }).passthrough()
})

describe('end-to-end SSE contract_event push', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('subscribed client receives contract_event notification and unsubscribed does not', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = `http://${host}:${port}/mcp`

    const transportA = new StreamableHTTPClientTransport(new URL(url))
    const clientA = new Client({ name: 'A', version: '0.0.0' }, { capabilities: {} })
    const receivedA: any[] = []
    clientA.setNotificationHandler(ContractEventNotificationSchema, (n) => { receivedA.push(n) })
    await clientA.connect(transportA)

    const transportB = new StreamableHTTPClientTransport(new URL(url))
    const clientB = new Client({ name: 'B', version: '0.0.0' }, { capabilities: {} })
    await clientB.connect(transportB)

    const transportC = new StreamableHTTPClientTransport(new URL(url))
    const clientC = new Client({ name: 'C', version: '0.0.0' }, { capabilities: {} })
    const receivedC: any[] = []
    clientC.setNotificationHandler(ContractEventNotificationSchema, (n) => { receivedC.push(n) })
    await clientC.connect(transportC)

    try {
      await clientA.callTool({ name: 'register_agent', arguments: { name: 'tester-11', model: 'm', role: 'r' } })
      await clientB.callTool({ name: 'register_agent', arguments: { name: 'tester-12', model: 'm', role: 'r' } })
      await clientC.callTool({ name: 'register_agent', arguments: { name: 'tester-13', model: 'm', role: 'r' } })

      // A subscribes; C does not
      const subA = parseTool(await clientA.callTool({ name: 'subscribe_contract', arguments: { name: 'X' } }))
      expect(subA.ok).toBe(true)

      // The SDK client auto-opens the standalone GET SSE stream on initialize — allow handshake to settle
      await new Promise(r => setTimeout(r, 100))

      // B publishes a contract registration for X
      const reg = parseTool(await clientB.callTool({
        name: 'register_contract',
        arguments: { name: 'X', schema: { type: 'object' } }
      }))
      expect(reg.version).toBe(1)

      // Wait for push delivery
      const deadline = Date.now() + 2000
      while (receivedA.length === 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50))
      }

      expect(receivedA.length).toBe(1)
      expect(receivedA[0].params.contract_name).toBe('X')
      expect(receivedA[0].params.version).toBe(1)
      expect(receivedA[0].params.type).toBe('contract_event')
      expect(typeof receivedA[0].params.event_id).toBe('number')

      // C was not subscribed — MUST NOT receive
      expect(receivedC.length).toBe(0)
    } finally {
      try { await transportA.terminateSession() } catch { /* ignore */ }
      try { await transportB.terminateSession() } catch { /* ignore */ }
      try { await transportC.terminateSession() } catch { /* ignore */ }
      await clientA.close()
      await clientB.close()
      await clientC.close()
      await app.close()
    }
  }, 20000)
})
