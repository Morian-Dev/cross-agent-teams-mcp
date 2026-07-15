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

  it('exposes reconnect with ui_pid and thread_id in tools/list', async () => {
    const { dir, server, client, transport } = await setup()
    cleanups.push(dir)
    const resp = await client.listTools()
    const tool = resp.tools.find(t => t.name === 'reconnect')
    expect(tool).toBeDefined()
    expect(tool!.inputSchema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        ui_pid: expect.anything(),
        thread_id: expect.anything(),
        ws_url: expect.anything(),
        auth_token_ref: expect.anything(),
      }),
    })
    expect(tool!.description).toContain('thread_id=$CODEX_THREAD_ID')
    expect(tool!.description).toContain('thread/resume')
    expect(tool!.description).toContain('stale stored identity')
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

  it('rejects invalid thread_id and mixed reconnect keys', async () => {
    const { dir, server, client, transport } = await setup()
    cleanups.push(dir)
    const invalid = await client.callTool({
      name: 'reconnect',
      arguments: { thread_id: 'not-a-uuid' },
    }) as { isError?: boolean }
    expect(invalid.isError).toBe(true)

    const mixed = await client.callTool({
      name: 'reconnect',
      arguments: {
        ui_pid: 25079,
        thread_id: '11111111-1111-4111-8111-111111111111',
      },
    }) as { isError?: boolean }
    expect(mixed.isError).toBe(true)

    const claudeWithCodexOption = await client.callTool({
      name: 'reconnect',
      arguments: { ui_pid: 25079, ws_url: 'ws://127.0.0.1:8799' },
    }) as { isError?: boolean }
    expect(claudeWithCodexOption.isError).toBe(true)

    const invalidWsUrl = await client.callTool({
      name: 'reconnect',
      arguments: {
        thread_id: '11111111-1111-4111-8111-111111111111',
        ws_url: 'https://example.com',
      },
    }) as { isError?: boolean }
    expect(invalidWsUrl.isError).toBe(true)

    await transport.close()
    await client.close()
    await server.close()
  })
})
