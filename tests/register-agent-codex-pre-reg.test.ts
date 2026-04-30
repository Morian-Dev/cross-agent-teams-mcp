import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { __testOverrides as autoBindOverrides } from '../src/mcp/auto-bind-codex-pane.js'

const detectTmuxPaneMock = vi.fn()
const bindRuntimeIdentityMock = vi.fn()

vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: detectTmuxPaneMock,
}))

vi.mock('../src/daemon/runtime-identity.js', () => ({
  bindRuntimeIdentity: bindRuntimeIdentityMock,
}))

// RegisterCodexSelfService is wrapped: real construction with real registerSvc,
// but its `register` method delegates straight to registerSvc.register so we
// skip the codex-appserver WS handshake entirely. This preserves agent-row
// writes (the tests assert on those) while avoiding a live websocket dependency.
vi.mock('../src/mcp/register-codex-self.js', () => {
  return {
    RegisterCodexSelfService: class {
      constructor(private readonly registerSvc: { register: (input: unknown) => unknown }) {}
      register(input: {
        connection_id: string
        name: string
        model?: string
        role?: string
        team?: string
        project_dir?: string
        thread_id?: string
        ws_url?: string
        auth_token_ref?: string
      }) {
        const result = this.registerSvc.register({
          connection_id: input.connection_id,
          agent_type: 'codex',
          model: input.model ?? 'codex',
          name: input.name,
          role: input.role,
          team: input.team,
          project_dir: input.project_dir,
          delivery: {
            kind: 'codex-appserver',
            thread_id: input.thread_id,
            ws_url: input.ws_url || 'ws://127.0.0.1:8799',
          },
        }) as Record<string, unknown>
        if ('error' in result) return result
        return {
          ...result,
          thread_id: input.thread_id,
          ws_url: input.ws_url || 'ws://127.0.0.1:8799',
        }
      }
    },
  }
})

const VALID_THREAD_ID = '11111111-1111-4111-8111-111111111111'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-codex-pre-reg-'))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

function resetAutoBindOverrides(): void {
  delete autoBindOverrides.listPanes
  delete autoBindOverrides.ttyProcesses
  delete autoBindOverrides.now
}

describe('register_agent codex pre-reg auto-bind', () => {
  const cleanups: string[] = []

  beforeEach(() => {
    detectTmuxPaneMock.mockReset()
    bindRuntimeIdentityMock.mockReset()
    // Default: detect_tmux_pane fallback returns ambiguous so the helper path
    // alone decides success / failure.
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    resetAutoBindOverrides()
  })

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    resetAutoBindOverrides()
  })

  it('auto-binds tmux pane via pending pre-reg when codex registers without ui_pid', async () => {
    bindRuntimeIdentityMock.mockResolvedValue({
      ok: true,
      tmux_pane_id: '%1972',
      verification_mode: 'verified_pid_tty_pane',
      tty: 'ttys001',
      ui_pid: 91131,
    })
    autoBindOverrides.listPanes = async () => [{ pane_id: '%1972', tty: 'ttys001' }]
    autoBindOverrides.ttyProcesses = async () =>
      ['91131 1 Ss codex --remote ws://127.0.0.1:8799 -c xats.agent_id="U1"']

    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({ dbPath, port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'codex-cli', version: '0.0.0' })
    await c.connect(t)

    // Launcher first pre-registers the pane
    const preReg = await c.callTool({
      name: 'pre_register_codex_pane',
      arguments: { pane_id: '%1972', xats_agent_id: 'U1' },
    })
    expect(await parseTool(preReg)).toMatchObject({ ok: true })

    // Then codex agent registers without ui_pid
    const resp = await c.callTool({
      name: 'register_agent',
      arguments: { agent_type: 'codex', model: 'gpt-5', role: 'worker', name: 'new-gpt', thread_id: VALID_THREAD_ID },
    })
    const obj = await parseTool(resp)

    expect(obj.agent_id).toBeDefined()
    expect(obj.hint).toBeUndefined()
    expect(bindRuntimeIdentityMock).toHaveBeenCalledWith(expect.objectContaining({
      agent: 'codex',
      ui_pid: 91131,
    }))

    const db = openDb(dbPath)
    applySchema(db)
    const row = db.prepare(
      'SELECT tmux_pane_id, runtime_ui_pid, runtime_tty FROM agents WHERE team=? AND name=?'
    ).get('default', 'new-gpt') as { tmux_pane_id: string | null; runtime_ui_pid: number | null; runtime_tty: string | null }
    expect(row).toEqual({ tmux_pane_id: '%1972', runtime_ui_pid: 91131, runtime_tty: 'ttys001' })
    const preregCount = db
      .prepare('SELECT COUNT(*) AS c FROM codex_pane_pre_registrations')
      .get() as { c: number }
    expect(preregCount.c).toBe(0)
    db.close()

    await t.close()
    await c.close()
    await app.close()
  })

  it('ignores an expired pre-reg and GCs it; register falls back to no-pane hint', async () => {
    autoBindOverrides.listPanes = async () => [{ pane_id: '%1972', tty: 'ttys001' }]
    autoBindOverrides.ttyProcesses = async () =>
      ['91131 1 Ss codex --remote -c xats.agent_id="U1"']

    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({ dbPath, port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'codex-cli', version: '0.0.0' })
    await c.connect(t)

    // Seed an already-expired pre-reg directly into the DB via a second connection
    const db = openDb(dbPath)
    applySchema(db)
    db.prepare(
      `INSERT INTO codex_pane_pre_registrations (pane_id, xats_agent_id, expires_at)
       VALUES (?, ?, ?)`
    ).run('%1972', 'U1', '2000-01-01T00:00:00.000Z')
    db.close()

    const resp = await c.callTool({
      name: 'register_agent',
      arguments: { agent_type: 'codex', model: 'gpt-5', role: 'worker', name: 'new-gpt', thread_id: VALID_THREAD_ID },
    })
    const obj = await parseTool(resp)

    expect(obj.agent_id).toBeDefined()
    // codex-appserver delivery is bound natively; no tmux fallback hint expected.
    expect(obj.hint).toBeUndefined()
    expect(bindRuntimeIdentityMock).not.toHaveBeenCalled()

    const db2 = openDb(dbPath)
    applySchema(db2)
    const preregCount = db2
      .prepare('SELECT COUNT(*) AS c FROM codex_pane_pre_registrations')
      .get() as { c: number }
    expect(preregCount.c).toBe(0)
    db2.close()

    await t.close()
    await c.close()
    await app.close()
  })

  it('leaves pre-reg intact when bind_runtime_identity fails, and register still succeeds', async () => {
    bindRuntimeIdentityMock.mockResolvedValue({ error: 'pid_has_no_tty' })
    autoBindOverrides.listPanes = async () => [{ pane_id: '%1972', tty: 'ttys001' }]
    autoBindOverrides.ttyProcesses = async () =>
      ['91131 1 Ss codex --remote -c xats.agent_id="U1"']

    const { startServer } = await import('../src/daemon/server.js')
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({ dbPath, port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'codex-cli', version: '0.0.0' })
    await c.connect(t)

    const preReg = await c.callTool({
      name: 'pre_register_codex_pane',
      arguments: { pane_id: '%1972', xats_agent_id: 'U1' },
    })
    expect(await parseTool(preReg)).toMatchObject({ ok: true })

    const resp = await c.callTool({
      name: 'register_agent',
      arguments: { agent_type: 'codex', model: 'gpt-5', role: 'worker', name: 'new-gpt', thread_id: VALID_THREAD_ID },
    })
    const obj = await parseTool(resp)

    expect(obj.agent_id).toBeDefined()
    // codex-appserver delivery is bound natively; no tmux fallback hint expected.
    expect(obj.hint).toBeUndefined()

    const db = openDb(dbPath)
    applySchema(db)
    const agentRow = db
      .prepare('SELECT tmux_pane_id FROM agents WHERE team=? AND name=?')
      .get('default', 'new-gpt') as { tmux_pane_id: string | null } | undefined
    expect(agentRow).toBeDefined()
    expect(agentRow?.tmux_pane_id).toBeNull()
    const preregRow = db
      .prepare('SELECT pane_id, xats_agent_id FROM codex_pane_pre_registrations')
      .get() as { pane_id: string; xats_agent_id: string } | undefined
    expect(preregRow).toEqual({ pane_id: '%1972', xats_agent_id: 'U1' })
    db.close()

    await t.close()
    await c.close()
    await app.close()
  })
})
