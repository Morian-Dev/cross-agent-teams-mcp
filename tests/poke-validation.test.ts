import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-poke-'))

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

async function register(c: Client, args: { role?: string; team?: string; tmux_pane_id?: string } = {}): Promise<string> {
  const resp = await c.callTool({
    name: 'register_agent',
    arguments: { model: 'opus-4-7', role: args.role ?? 'dev', team: args.team, tmux_pane_id: args.tmux_pane_id }
  })
  const obj = await parseTool(resp)
  return obj.agent_id as string
}

describe('poke validation', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('returns unknown_agent if caller has not registered', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const { c, t } = await connectClient(host, port)

    const resp = await c.callTool({ name: 'poke', arguments: { target_agent_id: 'any', prompt: 'p' } })
    const obj = await parseTool(resp)
    expect(obj).toEqual({ error: 'unknown_agent' })

    await t.terminateSession()
    await c.close()
    await app.close()
  })

  it('returns unknown_target when target_agent_id does not exist', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const { c, t } = await connectClient(host, port)
    await register(c)

    const resp = await c.callTool({ name: 'poke', arguments: { target_agent_id: 'ghost-xyz', prompt: 'p' } })
    const obj = await parseTool(resp)
    expect(obj).toEqual({ error: 'unknown_target' })

    await t.terminateSession()
    await c.close()
    await app.close()
  })

  it('returns self_poke_denied when caller pokes itself', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const { c, t } = await connectClient(host, port)
    const selfId = await register(c, { tmux_pane_id: '%1' })

    const resp = await c.callTool({ name: 'poke', arguments: { target_agent_id: selfId, prompt: 'p' } })
    const obj = await parseTool(resp)
    expect(obj).toEqual({ error: 'self_poke_denied' })

    await t.terminateSession()
    await c.close()
    await app.close()
  })

  it('returns tmux_pane_not_set when target has no tmux_pane_id', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const A = await connectClient(host, port)
    const B = await connectClient(host, port)
    await register(A.c, { role: 'caller' })
    const targetId = await register(B.c, { role: 'target' })

    const resp = await A.c.callTool({ name: 'poke', arguments: { target_agent_id: targetId, prompt: 'p' } })
    const obj = await parseTool(resp)
    expect(obj).toEqual({ error: 'tmux_pane_not_set' })

    await A.t.terminateSession(); await B.t.terminateSession()
    await A.c.close(); await B.c.close()
    await app.close()
  })

  it('returns prompt_too_long when prompt byte length exceeds 8192', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const A = await connectClient(host, port)
    const B = await connectClient(host, port)
    await register(A.c, { role: 'caller' })
    const targetId = await register(B.c, { role: 'target', tmux_pane_id: '%9' })

    const longPrompt = 'a'.repeat(10240)
    const resp = await A.c.callTool({ name: 'poke', arguments: { target_agent_id: targetId, prompt: longPrompt } })
    const obj = await parseTool(resp)
    expect(obj).toEqual({ error: 'prompt_too_long', detail: { max: 8192, got: 10240 } })

    await A.t.terminateSession(); await B.t.terminateSession()
    await A.c.close(); await B.c.close()
    await app.close()
  })

  it('returns cross_team_denied when caller and target are in different teams', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const A = await connectClient(host, port)
    const B = await connectClient(host, port)
    await register(A.c, { role: 'caller', team: 'alpha' })
    const targetId = await register(B.c, { role: 'target', team: 'beta', tmux_pane_id: '%9' })

    const resp = await A.c.callTool({ name: 'poke', arguments: { target_agent_id: targetId, prompt: 'p' } })
    const obj = await parseTool(resp)
    expect(obj).toEqual({ error: 'cross_team_denied' })

    await A.t.terminateSession(); await B.t.terminateSession()
    await A.c.close(); await B.c.close()
    await app.close()
  })
})
