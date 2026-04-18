import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-toolhint-'))

describe('tool descriptions: fire-and-forget tools hint at poke', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  async function listTools(): Promise<Array<{ name: string; description?: string }>> {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'test', version: '0.0.0' })
    await c.connect(t)
    const resp = await c.listTools()
    await t.close(); await app.close()
    return resp.tools
  }

  it('send_message description mentions poke for immediate wake-up', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'send_message')
    expect(tool).toBeDefined()
    expect(tool!.description).toMatch(/poke/i)
    expect(tool!.description).toMatch(/wake|immediate|immediately|interrupt/i)
  })

  it('broadcast description mentions per-recipient poke for immediate wake-up', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'broadcast')
    expect(tool).toBeDefined()
    expect(tool!.description).toMatch(/poke/i)
    expect(tool!.description).toMatch(/per-recipient|each recipient|each target/i)
  })

  it('task_add description mentions poke for nudging a specific agent', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'task_add')
    expect(tool).toBeDefined()
    expect(tool!.description).toMatch(/poke/i)
  })

  it('get_inbox description does NOT recommend poke (poke pushes, get_inbox pulls — no self-wake)', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'get_inbox')
    expect(tool).toBeDefined()
    expect(tool!.description).not.toMatch(/poke/i)
  })

  it('poke tool description remains (sanity: was not accidentally edited)', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'poke')
    expect(tool).toBeDefined()
    expect(tool!.description).toMatch(/wake/i)
    expect(tool!.description).toMatch(/retry/i)
  })

  it('register_agent description demands a pre-call tmux check (imperative, not advisory)', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'register_agent')
    expect(tool).toBeDefined()
    const d = tool!.description!
    expect(d).toMatch(/BEFORE calling this tool/i)
    expect(d).toMatch(/MUST/)
    expect(d).toMatch(/tmux display-message -p/)
    expect(d).toMatch(/tmux_pane_id/)
    expect(d).toMatch(/Do not skip the check/i)
  })

  it('register_agent description instructs how to handle both branches (in-tmux / not-in-tmux)', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'register_agent')
    const d = tool!.description!
    expect(d).toMatch(/pane id/i)
    expect(d).toMatch(/not a tmux client|errors|error/i)
    expect(d).toMatch(/skip/i)
  })
})
