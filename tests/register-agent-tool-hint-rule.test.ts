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

describe('register_agent tool hint rule (tmux + channel)', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('hint present when neither tmux_pane_id nor channel_session_id provided', async () => {
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
    expect(obj.hint).toMatch(/channel_session_id/i)

    await t.close(); await app.close()
  })

  it('hint suppressed when tmux_pane_id alone is provided', async () => {
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

  it('hint suppressed when channel_session_id alone is provided', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const { c, t } = await connectClient(host, port)

    const resp = await c.callTool({
      name: 'register_agent',
      arguments: {
        model: 'opus-4-7', role: 'frontend', name: 'alice',
        channel_session_id: 'csid-abc'
      }
    })
    const obj = await parseTool(resp)
    expect(obj.agent_id).toBeDefined()
    expect(obj.hint).toBeUndefined()
    await t.close(); await app.close()
  })

  it('hint present when channel_session_id is blank', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const { c, t } = await connectClient(host, port)

    const resp = await c.callTool({
      name: 'register_agent',
      arguments: {
        model: 'opus-4-7', role: 'frontend', name: 'alice',
        channel_session_id: '   '
      }
    })
    const obj = await parseTool(resp)
    expect(typeof obj.hint).toBe('string')
    await t.close(); await app.close()
  })

  it('error envelope never carries hint', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const { c, t } = await connectClient(host, port)

    const resp = await c.callTool({
      name: 'register_agent',
      arguments: { model: 'opus-4-7', role: 'frontend', name: 'alice' }
    })
    const obj = await parseTool(resp)
    if (obj.error !== undefined) expect(obj.hint).toBeUndefined()

    await t.close(); await app.close()
  })
})
