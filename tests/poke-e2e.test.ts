import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'
import { isTmuxAvailable, _resetTmuxAvailableCache } from '../src/daemon/tmux-cli.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-poke-e2e-'))

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

describe('poke e2e (real tmux)', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    _resetTmuxAvailableCache()
  })

  it('returns pane_dead when target pane was killed after registration', async () => {
    _resetTmuxAvailableCache()
    if (!(await isTmuxAvailable())) {
      console.warn('[poke-e2e] tmux unavailable; skipping pane_dead test')
      return
    }
    const session = `atm-test-dead-${process.pid}`
    execFileSync('tmux', ['new-session', '-d', '-s', session, 'cat'])
    let paneId = ''
    try {
      paneId = execFileSync('tmux', ['list-panes', '-t', session, '-F', '#{pane_id}']).toString().trim()
    } catch (e) {
      try { execFileSync('tmux', ['kill-session', '-t', session]) } catch { /* best-effort */ }
      throw e
    }

    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const A = await connectClient(host, port)
    const B = await connectClient(host, port)
    await register(A.c, { role: 'caller' })
    const targetId = await register(B.c, { role: 'target', tmux_pane_id: paneId })

    execFileSync('tmux', ['kill-session', '-t', session])

    const resp = await A.c.callTool({ name: 'poke', arguments: { target_agent_id: targetId, prompt: 'p' } })
    const obj = await parseTool(resp)
    expect(obj.error).toBe('pane_dead')
    expect(typeof obj.detail).toBe('string')

    await A.t.terminateSession(); await B.t.terminateSession()
    await A.c.close(); await B.c.close()
    await app.close()
  }, 20_000)

  it('happy path: poke returns before/after tails for live pane', async () => {
    _resetTmuxAvailableCache()
    if (!(await isTmuxAvailable())) {
      console.warn('[poke-e2e] tmux unavailable; skipping happy path test')
      return
    }
    const session = `atm-test-happy-${process.pid}`
    execFileSync('tmux', ['new-session', '-d', '-s', session, 'cat'])
    let paneId = ''
    try {
      paneId = execFileSync('tmux', ['list-panes', '-t', session, '-F', '#{pane_id}']).toString().trim()

      const dir = tmp(); cleanups.push(dir)
      const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
      const A = await connectClient(host, port)
      const B = await connectClient(host, port)
      await register(A.c, { role: 'caller' })
      const targetId = await register(B.c, { role: 'target', tmux_pane_id: paneId })

      const resp = await A.c.callTool({ name: 'poke', arguments: { target_agent_id: targetId, prompt: 'hello' } })
      const obj = await parseTool(resp)
      expect(obj.ok).toBe(true)
      expect(obj.pane_id).toBe(paneId)
      expect(typeof obj.pane_tail_before).toBe('string')
      expect(typeof obj.pane_tail_after).toBe('string')

      await A.t.terminateSession(); await B.t.terminateSession()
      await A.c.close(); await B.c.close()
      await app.close()
    } finally {
      try { execFileSync('tmux', ['kill-session', '-t', session]) } catch { /* best-effort */ }
    }
  }, 20_000)
})
