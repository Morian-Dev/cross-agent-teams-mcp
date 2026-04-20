import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'
import { _setTmuxAvailableForTest, _resetTmuxAvailableCache } from '../src/daemon/tmux-cli.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-poke-no-tmux-'))

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

async function register(c: Client, args: { name?: string; role?: string; team?: string; tmux_pane_id?: string } = {}): Promise<string> {
  const resp = await c.callTool({
    name: 'register_agent',
    arguments: { name: args.name ?? 'tester-7', model: 'opus-4-7', role: args.role ?? 'dev', team: args.team, tmux_pane_id: args.tmux_pane_id }
  })
  const obj = await parseTool(resp)
  return obj.agent_id as string
}

describe('poke tmux_unavailable', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    _resetTmuxAvailableCache()
  })

  it('returns tmux_unavailable when tmux binary is not available', async () => {
    _setTmuxAvailableForTest(false)

    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const A = await connectClient(host, port)
    const B = await connectClient(host, port)
    await register(A.c, { name: 'tester-7-caller', role: 'caller' })
    const targetId = await register(B.c, { name: 'tester-7-target', role: 'target', tmux_pane_id: '%42' })

    const resp = await A.c.callTool({ name: 'poke', arguments: { target_agent_id: targetId, prompt: 'hi' } })
    const obj = await parseTool(resp)
    expect(obj.error).toBe('tmux_unavailable')
    expect(typeof obj.detail).toBe('string')

    await A.t.terminateSession(); await B.t.terminateSession()
    await A.c.close(); await B.c.close()
    await app.close()
  })
})
