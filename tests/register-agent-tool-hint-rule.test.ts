import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-hint2-'))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

async function connectClient(host: string, port: number): Promise<{ c: Client; t: StreamableHTTPClientTransport }> {
  const url = new URL(`http://${host}:${port}/mcp`)
  const t = new StreamableHTTPClientTransport(url)
  const c = new Client({ name: 'test', version: '0.0.0' })
  await c.connect(t)
  return { c, t }
}

describe('register_agent tool hint rule (tmux only)', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('hint present when tmux_pane_id is not provided', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const { c, t } = await connectClient(host, port)

    const resp = await c.callTool({
      name: 'register_agent',
      arguments: { model: 'opus-4-7', role: 'frontend', name: 'alice' }
    })
    const obj = await parseTool(resp)

    expect(obj.agent_id).toBeDefined()
    expect(typeof obj.hint).toBe('string')
    expect(obj.hint).toMatch(/tmux_pane_id/i)

    await t.close(); await app.close()
  })

  it('hint suppressed when tmux_pane_id is provided', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const { c, t } = await connectClient(host, port)

    const resp = await c.callTool({
      name: 'register_agent',
      arguments: { model: 'opus-4-7', role: 'frontend', name: 'alice', tmux_pane_id: '%42' }
    })
    const obj = await parseTool(resp)
    expect(obj.agent_id).toBeDefined()
    expect(obj.hint).toBeUndefined()
    await t.close(); await app.close()
  })

  it('register_agent rejects unknown channel_session_id argument (not in schema)', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const { c, t } = await connectClient(host, port)

    // Passing channel_session_id must either be silently ignored (not persisted)
    // or rejected; either way the agent is created and the persisted row has
    // channel_session_id=NULL because register_agent is no longer a writer for it.
    const resp = await c.callTool({
      name: 'register_agent',
      arguments: {
        model: 'opus-4-7', role: 'frontend', name: 'alice', tmux_pane_id: '%42',
        channel_session_id: 'csid-should-not-be-written'
      }
    })
    const obj = await parseTool(resp)
    expect(obj.agent_id).toBeDefined()
    // The agents row should have channel_session_id=NULL because bind_channel is the only writer.
    const listResp = await c.callTool({ name: 'list_agents', arguments: {} })
    const list = await parseTool(listResp)
    const agents = list.agents as Array<{ name: string; channel_session_id: string | null }>
    const aliceRow = agents.find(a => a.name === 'alice')
    expect(aliceRow?.channel_session_id).toBeNull()

    await t.close(); await app.close()
  })
})
