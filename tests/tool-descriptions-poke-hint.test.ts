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

  interface ToolInfo {
    name: string
    description?: string
    inputSchema?: { properties?: Record<string, { type?: string }>; required?: string[] }
  }
  async function listTools(): Promise<ToolInfo[]> {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'test', version: '0.0.0' })
    await c.connect(t)
    const resp = await c.listTools()
    await t.close(); await app.close()
    return resp.tools as unknown as ToolInfo[]
  }

  it('send_message description mentions auto-poke default + quiet-guard', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'send_message')
    expect(tool).toBeDefined()
    const d = tool!.description!
    expect(d).toMatch(/poke/i)
    expect(d).toMatch(/by default|default/i)
    expect(d).toMatch(/quiet-guard|guard/i)
    expect(d).toMatch(/auto_poke/)
    expect(d).toMatch(/poked/)
    expect(d).toMatch(/poke_skip_reasons/)
    // retry-on-guard_failed behavior is documented
    expect(d).toMatch(/retry|backoff/i)
    expect(d).toMatch(/retry_scheduled/)
    expect(d).toMatch(/retry_delays_s/)
  })

  it('broadcast description states does NOT auto-poke by default and explains opt-in', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'broadcast')
    expect(tool).toBeDefined()
    const d = tool!.description!
    expect(d).toMatch(/poke/i)
    expect(d).toMatch(/not auto-poke|does NOT auto-poke|does not auto-poke/i)
    expect(d).toMatch(/auto_poke/)
    expect(d).toMatch(/quiet-guard|guard/i)
    expect(d).toMatch(/poked/)
    expect(d).toMatch(/poke_skip_reasons/)
    expect(d).toMatch(/retry|backoff/i)
    expect(d).toMatch(/retry_scheduled/)
    expect(d).toMatch(/retry_delays_s/)
  })

  it('send_message and broadcast tool schemas expose auto_poke as optional boolean', async () => {
    const tools = await listTools()
    const sm = tools.find(t => t.name === 'send_message')
    const bc = tools.find(t => t.name === 'broadcast')
    expect(sm).toBeDefined()
    expect(bc).toBeDefined()
    const smSchema = sm!.inputSchema!
    const bcSchema = bc!.inputSchema!
    expect(smSchema.properties?.auto_poke?.type).toBe('boolean')
    expect(bcSchema.properties?.auto_poke?.type).toBe('boolean')
    expect(smSchema.required ?? []).not.toContain('auto_poke')
    expect(bcSchema.required ?? []).not.toContain('auto_poke')
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

  it('poke description forbids using prompt as a content channel (wake-up only)', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'poke')
    const d = tool!.description!
    expect(d).toMatch(/SHORT/)
    expect(d).toMatch(/NOT a content channel|not a content channel/i)
    expect(d).toMatch(/send_message/)
    expect(d).toMatch(/mailbox/)
    expect(d).toMatch(/< 200 characters|200 characters/)
  })

  it('register_agent description demands a pre-call tmux check (imperative, not advisory)', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'register_agent')
    expect(tool).toBeDefined()
    const d = tool!.description!
    expect(d).toMatch(/BEFORE calling this tool/i)
    expect(d).toMatch(/MUST/)
    expect(d).toMatch(/TMUX_PANE/)
    expect(d).toMatch(/tmux_pane_id/)
    expect(d).toMatch(/Do not skip the check/i)
  })

  it('register_agent description prefers $TMUX_PANE over tmux display-message (per-pane reliability)', async () => {
    const tools = await listTools()
    const tool = tools.find(t => t.name === 'register_agent')
    const d = tool!.description!
    expect(d).toMatch(/\$TMUX_PANE/)
    expect(d).toMatch(/echo "\$TMUX_PANE"/)
    expect(d).toMatch(/Do NOT use `tmux display-message/i)
    expect(d).toMatch(/focused/i)
    expect(d).toMatch(/fallback/i)
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
