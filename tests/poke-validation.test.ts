import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

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

async function register(c: Client, args: {
  name?: string
  role?: string
  team?: string
  tmux_pane_id?: string
  dbPath?: string
  delivery?: Record<string, unknown>
} = {}): Promise<string> {
  const resp = await c.callTool({
    name: 'register_agent',
    arguments: {
      name: args.name ?? 'tester-8',
      model: 'opus-4-7',
      role: args.role ?? 'dev',
      team: args.team,
      delivery: args.delivery,
    }
  })
  const obj = await parseTool(resp)
  const agentId = obj.agent_id as string
  if (args.dbPath && args.tmux_pane_id) {
    const db = openDb(args.dbPath)
    applySchema(db)
    db.prepare('UPDATE agents SET tmux_pane_id=? WHERE agent_id=?')
      .run(args.tmux_pane_id, agentId)
    db.close()
  }
  return agentId
}

type EventName = 'open' | 'message' | 'error' | 'close'

class MockCodexWebSocket {
  private readonly listeners: Record<EventName, Set<(event: unknown) => void>> = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  }

  constructor(_url: string, _options?: { headers?: Record<string, string> }) {
    queueMicrotask(() => this.emit('open', {}))
  }

  addEventListener(type: EventName, listener: (event: unknown) => void): void {
    this.listeners[type].add(listener)
  }

  removeEventListener(type: EventName, listener: (event: unknown) => void): void {
    this.listeners[type].delete(listener)
  }

  send(data: string): void {
    const message = JSON.parse(data) as { id?: number; method?: string }
    if (message.method === 'initialize' && typeof message.id === 'number') {
      this.emit('message', {
        data: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } }),
      })
    }
    if (message.method === 'thread/resume' && typeof message.id === 'number') {
      this.emit('message', {
        data: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } }),
      })
    }
    if (message.method === 'turn/start' && typeof message.id === 'number') {
      this.emit('message', {
        data: JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } }),
      })
    }
  }

  close(): void {
    return
  }

  private emit(type: EventName, event: unknown): void {
    for (const listener of this.listeners[type]) {
      listener(event)
    }
  }
}

describe('poke validation', () => {
  const cleanups: string[] = []
  beforeEach(() => {
    vi.stubGlobal('WebSocket', MockCodexWebSocket as unknown as typeof WebSocket)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
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
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({ dbPath, port: 0 })
    const { c, t } = await connectClient(host, port)
    const selfId = await register(c, { tmux_pane_id: '%1', dbPath })

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
    await register(A.c, { name: 'tester-8-caller', role: 'caller' })
    const targetId = await register(B.c, { name: 'tester-8-target', role: 'target' })

    const resp = await A.c.callTool({ name: 'poke', arguments: { target_agent_id: targetId, prompt: 'p' } })
    const obj = await parseTool(resp)
    expect(obj).toEqual({ error: 'no_transport_available', detail: { channel_subscribed: false, opencode_bound: false, tmux_pane_set: false } })

    await A.t.terminateSession(); await B.t.terminateSession()
    await A.c.close(); await B.c.close()
    await app.close()
  })

  it('returns prompt_too_long when prompt byte length exceeds 8192', async () => {
    const dir = tmp(); cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({ dbPath, port: 0 })
    const A = await connectClient(host, port)
    const B = await connectClient(host, port)
    await register(A.c, { role: 'caller' })
    const targetId = await register(B.c, { role: 'target', tmux_pane_id: '%9', dbPath })

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
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({ dbPath, port: 0 })
    const A = await connectClient(host, port)
    const B = await connectClient(host, port)
    await register(A.c, { role: 'caller', team: 'alpha' })
    const targetId = await register(B.c, { role: 'target', team: 'beta', tmux_pane_id: '%9', dbPath })

    const resp = await A.c.callTool({ name: 'poke', arguments: { target_agent_id: targetId, prompt: 'p' } })
    const obj = await parseTool(resp)
    expect(obj).toEqual({ error: 'cross_team_denied' })

    await A.t.terminateSession(); await B.t.terminateSession()
    await A.c.close(); await B.c.close()
    await app.close()
  })

  it('routes codex-appserver target without tmux through Codex transport', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const A = await connectClient(host, port)
    const B = await connectClient(host, port)
    await register(A.c, { name: 'caller-codex', role: 'caller' })
    const targetId = await register(B.c, {
      name: 'target-codex',
      role: 'target',
      delivery: {
        kind: 'codex-appserver',
        thread_id: '11111111-1111-4111-8111-111111111111',
        ws_url: 'ws://127.0.0.1:8799',
      },
    })

    const resp = await A.c.callTool({
      name: 'poke',
      arguments: { target_agent_id: targetId, prompt: 'p' },
    })
    const obj = await parseTool(resp)
    expect(obj).toEqual({
      ok: true,
      transport_used: 'codex-appserver',
      thread_id: '11111111-1111-4111-8111-111111111111',
    })

    await A.t.terminateSession(); await B.t.terminateSession()
    await A.c.close(); await B.c.close()
    await app.close()
  })
})
