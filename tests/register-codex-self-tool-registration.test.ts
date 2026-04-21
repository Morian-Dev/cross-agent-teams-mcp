import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-register-codex-self-tool-'))

describe('register_codex_self tool registration', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('register_codex_self appears in list_tools with name/team/role style inputs', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'test', version: '0.0.0' })
    await c.connect(t)

    const tools = await c.listTools()
    const tool = tools.tools.find(x => x.name === 'register_codex_self')
    expect(tool).toBeDefined()
    expect(tool!.inputSchema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        name: expect.anything(),
        team: expect.anything(),
        role: expect.anything(),
      })
    })
    expect(tool!.description).toMatch(/Codex-only/i)
    expect(tool!.description).toMatch(/Do NOT use this tool from Claude Code or opencode/i)
    expect(tool!.description).toMatch(/register_agent/i)

    await t.terminateSession()
    await c.close()
    await app.close()
  })
})
