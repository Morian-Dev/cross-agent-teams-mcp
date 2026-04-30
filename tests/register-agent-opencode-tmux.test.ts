import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { insertAgent } from './helpers/insert-agent.js'
import { poke } from '../src/mcp/poke.js'

const bindRuntimeIdentityMock = vi.fn()
const detectTmuxPaneMock = vi.fn()

vi.mock('../src/daemon/runtime-identity.js', () => ({
  bindRuntimeIdentity: bindRuntimeIdentityMock,
}))

vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: detectTmuxPaneMock,
}))

vi.mock('../src/daemon/tmux-cli.js', () => ({
  isTmuxAvailable: async () => true,
  capturePaneTail: async () => 'pane-tail-placeholder',
  loadBuffer: async () => undefined,
  pasteBuffer: async () => undefined,
  sendEnter: async () => undefined,
}))

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-opencode-tmux-'))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

describe('register_agent({agent_type:"opencode", ui_pid}) binds tmux pane and poke uses tmux', () => {
  const cleanups: string[] = []

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    bindRuntimeIdentityMock.mockReset()
    detectTmuxPaneMock.mockReset()
  })

  it('binds tmux_pane_id via pid-based path and poke delivers via tmux-poke', async () => {
    bindRuntimeIdentityMock.mockResolvedValue({
      ok: true,
      tmux_pane_id: '%77',
      verification_mode: 'verified_pid_tty_pane',
      tty: 'ttys077',
      ui_pid: 31415,
    })

    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({ dbPath, port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'opencode-cli', version: '0.0.0' })
    await c.connect(t)

    const resp = await c.callTool({
      name: 'register_agent',
      arguments: {
        agent_type: 'opencode',
        model: 'opencode-default',
        role: 'worker',
        name: 'alice',
        ui_pid: 31415,
      },
    })
    const obj = await parseTool(resp)

    expect(obj.agent_id).toBeDefined()
    expect(obj.hint).toBeUndefined()
    expect(bindRuntimeIdentityMock).toHaveBeenCalledWith({
      callerAgentId: expect.any(String),
      agent: 'opencode',
      ui_pid: 31415,
    })

    const db = openDb(dbPath)
    applySchema(db)
    const row = db.prepare(
      'SELECT agent_type, tmux_pane_id, runtime_ui_pid FROM agents WHERE team=? AND name=?'
    ).get('default', 'alice') as {
      agent_type: string | null
      tmux_pane_id: string | null
      runtime_ui_pid: number | null
    }
    expect(row).toEqual({
      agent_type: 'opencode',
      tmux_pane_id: '%77',
      runtime_ui_pid: 31415,
    })

    const callerAgentId = insertAgent(db, {
      agent_id: 'caller-agent',
      agent_type: 'claude-code',
      role: 'lead',
      name: 'caller',
      tmux_pane_id: '%1',
    })

    const pokeResult = await poke(
      { db, callerAgentId },
      { target_agent_id: String(obj.agent_id), prompt: 'wake up' }
    )

    expect(pokeResult).toMatchObject({
      ok: true,
      transport_used: 'tmux-poke',
      pane_id: '%77',
      pane_tail_before: expect.any(String),
      pane_tail_after: expect.any(String),
    })

    db.close()
    await t.close()
    await c.close()
    await app.close()
  })
})
