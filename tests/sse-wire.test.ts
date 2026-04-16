import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'
import { SseFanout } from '../src/daemon/sse-fanout.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

function parseTool(res: unknown): any {
  const r = res as { content: Array<{ type: string; text: string }> }
  return JSON.parse(r.content[0].text)
}

describe('SSE fanout wired into register_contract', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('register_contract triggers emitContractEvent on the injected daemon fanout', async () => {
    const dir = tmp(); cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const emitted: Array<Record<string, unknown>> = []
    const fanout = new SseFanout()
    const origEmit = fanout.emitContractEvent.bind(fanout)
    fanout.emitContractEvent = (db, args) => { emitted.push({ ...args }); return origEmit(db, args) }

    const { app, port, host } = await startServer({ dbPath, port: 0, fanout })
    const url = `http://${host}:${port}/mcp`

    const publisher = new StreamableHTTPClientTransport(new URL(url))
    const publisherClient = new Client({ name: 'pub', version: '0.0.0' }, { capabilities: {} })
    await publisherClient.connect(publisher)
    const subscriber = new StreamableHTTPClientTransport(new URL(url))
    const subscriberClient = new Client({ name: 'sub', version: '0.0.0' }, { capabilities: {} })
    await subscriberClient.connect(subscriber)

    try {
      await publisherClient.callTool({
        name: 'register_agent', arguments: { model: 'm', role: 'r' }
      })
      await subscriberClient.callTool({
        name: 'register_agent', arguments: { model: 'm', role: 'r' }
      })
      const subRes = parseTool(await subscriberClient.callTool({
        name: 'subscribe_contract', arguments: { name: 'X' }
      }))
      expect(subRes.ok).toBe(true)

      const reg = parseTool(await publisherClient.callTool({
        name: 'register_contract',
        arguments: { name: 'X', schema: { type: 'object' } }
      }))
      expect(reg.name).toBe('X')
      expect(reg.version).toBe(1)

      expect(emitted.length).toBe(1)
      expect(emitted[0].contract_name).toBe('X')
      expect(emitted[0].version).toBe(1)
      expect(emitted[0].team).toBe('default')
      expect(typeof emitted[0].event_id).toBe('number')
    } finally {
      await publisherClient.close()
      await subscriberClient.close()
      await app.close()
    }
  }, 20000)
})
