import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const detectTmuxPaneMock = vi.fn()
const bindRuntimeIdentityMock = vi.fn()

vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: detectTmuxPaneMock,
}))

vi.mock('../src/daemon/runtime-identity.js', () => ({
  bindRuntimeIdentity: bindRuntimeIdentityMock,
}))

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-register-auto-bind-'))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

describe('register_agent auto runtime binding', () => {
  const cleanups: string[] = []

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    detectTmuxPaneMock.mockReset()
    bindRuntimeIdentityMock.mockReset()
  })

  it('best-effort binds a recognized Codex client during registration', async () => {
    detectTmuxPaneMock.mockResolvedValue({
      ok: true,
      pane: {
        pane_id: '%1902',
        session_name: 's1',
        window_index: 0,
        pane_index: 1,
        active: true,
        tty: 'ttys026',
        current_path: '/tmp',
        current_command: 'codex-aarch64-a',
        title: 'codex',
        matched_processes: ['123 codex --remote ws://127.0.0.1:8799'],
        score: 99,
      },
      candidates: [],
    })
    bindRuntimeIdentityMock.mockResolvedValue({
      ok: true,
      tmux_pane_id: '%1902',
      verification_mode: 'verified_tty_pane',
      tty: 'ttys026',
    })

    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({ dbPath, port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'codex-cli', version: '0.0.0' })
    await c.connect(t)

    const resp = await c.callTool({
      name: 'register_agent',
      arguments: { client: 'codex', model: 'gpt-5', role: 'worker', name: 'alice' },
    })
    const obj = await parseTool(resp)

    expect(obj.agent_id).toBeDefined()
    expect(obj.hint).toBeUndefined()
    expect(detectTmuxPaneMock).toHaveBeenCalledWith({ agent: 'codex' })
    expect(bindRuntimeIdentityMock).toHaveBeenCalledWith({
      callerAgentId: expect.any(String),
      agent: 'codex',
      ui_tty: 'ttys026',
      tmux_pane_id: '%1902',
    })

    const db = openDb(dbPath)
    applySchema(db)
    const row = db.prepare(
      'SELECT tmux_pane_id, runtime_tty, runtime_verification_mode FROM agents WHERE team=? AND name=?'
    ).get('default', 'alice') as {
      tmux_pane_id: string | null
      runtime_tty: string | null
      runtime_verification_mode: string | null
    }
    expect(row).toEqual({
      tmux_pane_id: '%1902',
      runtime_tty: 'ttys026',
      runtime_verification_mode: 'verified_tty_pane',
    })
    db.close()

    await t.close()
    await c.close()
    await app.close()
  })

  it('prefers ui_pid when provided during registration', async () => {
    bindRuntimeIdentityMock.mockResolvedValue({
      ok: true,
      tmux_pane_id: '%1902',
      verification_mode: 'verified_pid_tty_pane',
      tty: 'ttys026',
      ui_pid: 25079,
    })

    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({ dbPath, port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'codex-cli', version: '0.0.0' })
    await c.connect(t)

    const resp = await c.callTool({
      name: 'register_agent',
      arguments: { client: 'codex', model: 'gpt-5', role: 'worker', name: 'alice', ui_pid: 25079 },
    })
    const obj = await parseTool(resp)

    expect(obj.agent_id).toBeDefined()
    expect(obj.hint).toBeUndefined()
    expect(bindRuntimeIdentityMock).toHaveBeenCalledWith({
      callerAgentId: expect.any(String),
      agent: 'codex',
      ui_pid: 25079,
    })
    expect(detectTmuxPaneMock).not.toHaveBeenCalled()

    const db = openDb(dbPath)
    applySchema(db)
    const row = db.prepare(
      'SELECT tmux_pane_id, runtime_ui_pid, runtime_tty, runtime_verification_mode FROM agents WHERE team=? AND name=?'
    ).get('default', 'alice') as {
      tmux_pane_id: string | null
      runtime_ui_pid: number | null
      runtime_tty: string | null
      runtime_verification_mode: string | null
    }
    expect(row).toEqual({
      tmux_pane_id: '%1902',
      runtime_ui_pid: 25079,
      runtime_tty: 'ttys026',
      runtime_verification_mode: 'verified_pid_tty_pane',
    })
    db.close()

    await t.close()
    await c.close()
    await app.close()
  })

  it('falls back to a hint when automatic runtime binding does not converge', async () => {
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })

    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'codex-cli', version: '0.0.0' })
    await c.connect(t)

    const resp = await c.callTool({
      name: 'register_agent',
      arguments: { client: 'codex', model: 'gpt-5', role: 'worker', name: 'alice' },
    })
    const obj = await parseTool(resp)

    expect(obj.agent_id).toBeDefined()
    expect(typeof obj.hint).toBe('string')
    expect(String(obj.hint)).toMatch(/automatic runtime binding did not converge/i)
    expect(bindRuntimeIdentityMock).not.toHaveBeenCalled()

    await t.close()
    await c.close()
    await app.close()
  })
})
