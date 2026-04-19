import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-desc-'))

describe('send_message description', () => {
  const dirs: string[] = []
  afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

  it('mentions to_agent_name, one-of guard, and to_team guardrail', async () => {
    const dir = tmp(); dirs.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'test', version: '0' })
    await c.connect(t)
    const tools = await c.listTools()
    const sm = tools.tools.find((x) => x.name === 'send_message')
    expect(sm).toBeDefined()
    const desc = sm!.description ?? ''
    expect(desc).toMatch(/to_agent_name/)
    expect(desc).toMatch(/(exactly one|one of|任选其一|精确之一)/i)
    expect(desc).toMatch(/to_team/)
    await t.close(); await app.close()
  })
})
