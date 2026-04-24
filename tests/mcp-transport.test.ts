import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/daemon/server.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

async function rpc(url: string, body: unknown, sessionId?: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'accept': 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {})
    },
    body: JSON.stringify(body)
  })
  return res
}

async function readJsonOrSSE(res: Response): Promise<any> {
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('text/event-stream')) {
    const text = await res.text()
    const lines = text.split(/\n/).filter(l => l.startsWith('data:'))
    const last = lines[lines.length - 1]
    return last ? JSON.parse(last.slice(5).trim()) : null
  }
  return res.json()
}

describe('mcp transport', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('initialize returns protocolVersion and tools capability', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = `http://${host}:${port}/mcp`
    const res = await rpc(url, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }
    })
    expect(res.status).toBe(200)
    const body = await readJsonOrSSE(res)
    expect(body.result.protocolVersion).toBeDefined()
    expect(body.result.capabilities.tools).toBeDefined()
    expect(body.result.instructions).toEqual(expect.any(String))
    expect(body.result.instructions.length).toBeGreaterThan(0)
    expect(body.result.instructions).toContain('xats')
    expect(body.result.instructions).toContain('cross-agent-teams')
    expect(body.result.instructions).toContain('project_dir')
    expect(res.headers.get('Mcp-Session-Id')).toMatch(/[a-f0-9-]{10,}/i)
    await app.close()
  })

  it('two clients receive distinct session ids', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = `http://${host}:${port}/mcp`
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }
    const r1 = await rpc(url, init)
    const r2 = await rpc(url, init)
    const s1 = r1.headers.get('Mcp-Session-Id')
    const s2 = r2.headers.get('Mcp-Session-Id')
    expect(s1).toBeTruthy()
    expect(s2).toBeTruthy()
    expect(s1).not.toBe(s2)
    await app.close()
  })

  it('unknown session id returns 400 unknown_session', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = `http://${host}:${port}/mcp`
    const res = await rpc(url, {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { msg: 'hi' } }
    }, '00000000-0000-0000-0000-000000000000')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'unknown_session' })
    await app.close()
  })

  it('echo returns msg and echoed_at', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = `http://${host}:${port}/mcp`
    const init = await rpc(url, {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } }
    })
    const sid = init.headers.get('Mcp-Session-Id')!
    await rpc(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid)
    const call = await rpc(url, {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { msg: 'hi' } }
    }, sid)
    const body = await readJsonOrSSE(call)
    const content = body.result.content[0]
    const parsed = JSON.parse(content.text)
    expect(parsed.msg).toBe('hi')
    expect(typeof parsed.echoed_at).toBe('string')
    expect(new Date(parsed.echoed_at).toString()).not.toBe('Invalid Date')
    await app.close()
  })
})
