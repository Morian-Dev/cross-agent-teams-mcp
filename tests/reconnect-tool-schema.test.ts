import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerBusinessTools } from '../src/mcp/tools.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-reconnect-schema-'))

async function setup() {
  const dir = tmp()
  const dbPath = join(dir, 'data.db')
  const db = openDb(dbPath)
  applySchema(db)
  const server = new McpServer({ name: 'test-server', version: '0.0.0' })
  const holder: { current: string | undefined } = { current: undefined }
  const sessionId = 'session-reconnect-schema'
  registerBusinessTools(
    server,
    db,
    () => holder.current ?? sessionId,
    undefined,
    (agentId) => { holder.current = agentId },
    () => sessionId,
  )
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: 'claude-code', version: '0.0.0' })
  await client.connect(ct)
  return { dir, db, server, client, transport: ct }
}

describe('reconnect tool schema validation', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('exposes reconnect with a required ui_pid in tools/list', async () => {
    const { dir, server, client, transport } = await setup()
    cleanups.push(dir)
    const resp = await client.listTools()
    const tool = resp.tools.find(t => t.name === 'reconnect')
    expect(tool).toBeDefined()
    expect(tool!.inputSchema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({ ui_pid: expect.anything() }),
      required: expect.arrayContaining(['ui_pid']),
    })
    await transport.close()
    await client.close()
    await server.close()
  })

  it('rejects ui_pid: 0 at the schema layer without reading/mutating a row', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    const resp = await client.callTool({ name: 'reconnect', arguments: { ui_pid: 0 } }) as {
      isError?: boolean
    }
    expect(resp.isError).toBe(true)
    const count = db.prepare(`SELECT COUNT(*) AS c FROM agents`).get() as { c: number }
    expect(count.c).toBe(0)
    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('rejects missing ui_pid (reconnect({})) at the schema layer', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    const resp = await client.callTool({ name: 'reconnect', arguments: {} }) as {
      isError?: boolean
    }
    expect(resp.isError).toBe(true)
    const count = db.prepare(`SELECT COUNT(*) AS c FROM agents`).get() as { c: number }
    expect(count.c).toBe(0)
    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('rejects non-integer / negative ui_pid', async () => {
    const { dir, server, client, transport } = await setup()
    cleanups.push(dir)
    for (const bad of [-1, 1.5]) {
      const resp = await client.callTool({ name: 'reconnect', arguments: { ui_pid: bad } }) as {
        isError?: boolean
      }
      expect(resp.isError, `ui_pid=${bad} should be rejected`).toBe(true)
    }
    await transport.close()
    await client.close()
    await server.close()
  })
})
