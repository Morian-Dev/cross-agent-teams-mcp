import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'
import { SseFanout } from '../src/daemon/sse-fanout.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('SSE fanout attach/rebind/detach wiring into MCP sessions', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('attaches session on init, rebinds team on register_agent, detaches on close', async () => {
    const dir = tmp(); cleanups.push(dir)
    const fanout = new SseFanout()
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0, fanout })
    const url = `http://${host}:${port}/mcp`

    const transport = new StreamableHTTPClientTransport(new URL(url))
    const client = new Client({ name: 'a', version: '0.0.0' }, { capabilities: {} })
    await client.connect(transport)
    const sid = transport.sessionId!
    expect(sid).toBeTruthy()

    try {
      const afterInit = fanout.peek()
      expect(afterInit.length).toBe(1)
      expect(afterInit[0]).toEqual({ agent_id: sid, team: 'default' })

      await client.callTool({ name: 'register_agent', arguments: { model: 'm', role: 'r', team: 'alpha' } })
      const afterRegister = fanout.peek()
      expect(afterRegister.length).toBe(1)
      expect(afterRegister[0]).toEqual({ agent_id: sid, team: 'alpha' })
    } finally {
      await transport.terminateSession()
      await client.close()
    }

    await new Promise(r => setTimeout(r, 50))
    expect(fanout.peek().length).toBe(0)

    await app.close()
  }, 15000)
})
