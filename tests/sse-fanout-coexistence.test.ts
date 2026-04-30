import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { startServer } from '../src/daemon/server.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-hbcoex-'))

function parseTool(res: unknown): any {
  const r = res as { content: Array<{ type: string; text: string }> }
  return JSON.parse(r.content[0].text)
}

const HeartbeatNotification = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.literal('notifications/heartbeat'),
  params: z.any().optional()
})

const ContractEventNotification = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.literal('notifications/contract_event'),
  params: z.object({
    type: z.literal('contract_event'),
    event_id: z.number(),
    contract_name: z.string(),
    version: z.number(),
    diff: z.unknown().nullable()
  }).passthrough()
})

describe('sse fanout heartbeat / contract_event coexistence', () => {
  const cleanups: string[] = []
  const savedEnv = { ...process.env }
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0
    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k]
    for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v
  })

  it('subscriber receives both heartbeat(s) and a contract_event without interference', async () => {
    process.env.HEARTBEAT_INTERVAL_MS = '100'
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = `http://${host}:${port}/mcp`

    const transportA = new StreamableHTTPClientTransport(new URL(url))
    const clientA = new Client({ name: 'A', version: '0.0.0' }, { capabilities: {} })
    const heartbeatsA: any[] = []
    const contractEventsA: any[] = []
    clientA.setNotificationHandler(HeartbeatNotification as any, async (n) => { heartbeatsA.push(n) })
    clientA.setNotificationHandler(ContractEventNotification as any, async (n) => { contractEventsA.push(n) })
    await clientA.connect(transportA)

    const transportB = new StreamableHTTPClientTransport(new URL(url))
    const clientB = new Client({ name: 'B', version: '0.0.0' }, { capabilities: {} })
    await clientB.connect(transportB)

    try {
      await clientA.callTool({ name: 'register_agent', arguments: { agent_type: 'custom', name: 'tester-14', model: 'm', role: 'r' } })
      await clientB.callTool({ name: 'register_agent', arguments: { agent_type: 'custom', name: 'tester-15', model: 'm', role: 'r' } })

      const subA = parseTool(await clientA.callTool({ name: 'subscribe_contract', arguments: { name: 'X' } }))
      expect(subA.ok).toBe(true)

      // Let heartbeat tick a few times before the contract event
      await new Promise(r => setTimeout(r, 300))

      const reg = parseTool(await clientB.callTool({
        name: 'register_contract',
        arguments: { name: 'X', schema: { type: 'object' } }
      }))
      expect(reg.version).toBe(1)

      const deadline = Date.now() + 2000
      while (contractEventsA.length === 0 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 50))
      }

      expect(heartbeatsA.length).toBeGreaterThanOrEqual(1)
      expect(contractEventsA.length).toBe(1)
      expect(contractEventsA[0].params.contract_name).toBe('X')
      expect(contractEventsA[0].params.version).toBe(1)
      expect(contractEventsA[0].params.type).toBe('contract_event')
    } finally {
      try { await transportA.terminateSession() } catch { /* ignore */ }
      try { await transportB.terminateSession() } catch { /* ignore */ }
      await clientA.close()
      await clientB.close()
      await app.close()
    }
  }, 20000)
})
