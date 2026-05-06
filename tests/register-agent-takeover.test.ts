import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-takeover-'))

interface Connected {
  c: Client
  t: StreamableHTTPClientTransport
}

async function connectClient(host: string, port: number): Promise<Connected> {
  const url = new URL(`http://${host}:${port}/mcp`)
  const t = new StreamableHTTPClientTransport(url)
  const c = new Client({ name: 'takeover-test', version: '0.0.0' })
  await c.connect(t)
  return { c, t }
}

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

describe('register_agent cross-session takeover', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('second session re-claims (team, name): 200 + same agent_id, prior session removed from daemon sessions Map', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })

    // Session A registers
    const a = await connectClient(host, port)
    const r1 = await parseTool(await a.c.callTool({
      name: 'register_agent',
      arguments: { agent_type: 'custom', name: 'alice', model: 'm', role: 'r' }
    }))
    expect(r1.agent_id).toBeDefined()
    const sidA = a.t.sessionId
    expect(typeof sidA).toBe('string')

    // Session B re-claims same (team, name)
    const b = await connectClient(host, port)
    const r2 = await parseTool(await b.c.callTool({
      name: 'register_agent',
      arguments: { agent_type: 'custom', name: 'alice', model: 'm', role: 'r' }
    }))
    expect(r2.error).toBeUndefined()
    expect(r2.agent_id).toBe(r1.agent_id)

    // Allow the daemon onclose chain to settle.
    await new Promise(r => setTimeout(r, 200))

    // The old session id MUST no longer be present on the daemon: a raw POST
    // with the old session id returns unknown_session.
    const probeUrl = `http://${host}:${port}/mcp`
    const probe = await fetch(probeUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
        'mcp-session-id': sidA!,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    })
    expect(probe.status).toBe(400)
    expect(await probe.json()).toEqual({ error: 'unknown_session' })

    try { await a.t.close() } catch { /* already closed */ }
    await b.c.close()
    await app.close()
  }, 15000)

  it('clean reconnect after explicit close does NOT log takeover (registerSvc binding released on session close)', async () => {
    const dir = tmp(); cleanups.push(dir)
    const lines: string[] = []
    const origDebug = console.debug
    console.debug = ((...args: unknown[]): void => {
      lines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '))
    }) as typeof console.debug
    try {
      const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })

      // Session A registers, then closes cleanly via DELETE.
      const a = await connectClient(host, port)
      await a.c.callTool({
        name: 'register_agent',
        arguments: { agent_type: 'custom', name: 'alice', model: 'm', role: 'r' }
      })
      await a.t.terminateSession()
      await a.c.close()

      // Allow onclose chain (and our new releaseConnection call) to settle.
      await new Promise(r => setTimeout(r, 200))

      // Reset captured lines so we only assert on the second register attempt.
      lines.length = 0

      // Session B re-registers same (team, name) — should be a clean reuse,
      // not a takeover, because A's connection_id was released on close.
      const b = await connectClient(host, port)
      await b.c.callTool({
        name: 'register_agent',
        arguments: { agent_type: 'custom', name: 'alice', model: 'm', role: 'r' }
      })

      const takeoverLine = lines.find(l => l.includes('register_agent takeover'))
      expect(
        takeoverLine,
        `did NOT expect takeover log on clean reconnect; lines=${JSON.stringify(lines)}`
      ).toBeUndefined()

      await b.c.close()
      await app.close()
    } finally {
      console.debug = origDebug
    }
  }, 15000)

  it('emits a debug-level takeover log identifying old/new sids and (team, name)', async () => {
    const dir = tmp(); cleanups.push(dir)
    const lines: string[] = []
    const origDebug = console.debug
    console.debug = ((...args: unknown[]): void => {
      lines.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' '))
    }) as typeof console.debug
    try {
      const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })

      const a = await connectClient(host, port)
      await a.c.callTool({
        name: 'register_agent',
        arguments: { agent_type: 'custom', name: 'alice', model: 'm', role: 'r' }
      })
      const sidA = a.t.sessionId!

      const b = await connectClient(host, port)
      await b.c.callTool({
        name: 'register_agent',
        arguments: { agent_type: 'custom', name: 'alice', model: 'm', role: 'r' }
      })
      const sidB = b.t.sessionId!

      const takeoverLine = lines.find(l => l.includes('register_agent takeover'))
      expect(takeoverLine, `expected takeover log; lines=${JSON.stringify(lines)}`).toBeDefined()
      expect(takeoverLine!).toContain(`old=${sidA}`)
      expect(takeoverLine!).toContain(`new=${sidB}`)
      expect(takeoverLine!).toContain('team=default')
      expect(takeoverLine!).toContain('name=alice')

      try { await a.t.close() } catch { /* already closed */ }
      await b.c.close()
      await app.close()
    } finally {
      console.debug = origDebug
    }
  }, 15000)
})
