import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const registerCodexSelfMock = vi.fn()
const detectTmuxPaneMock = vi.fn()
const bindRuntimeIdentityMock = vi.fn()

vi.mock('../src/mcp/register-codex-self.js', () => ({
  RegisterCodexSelfService: class {
    register(input: unknown) {
      return registerCodexSelfMock(input)
    }
  },
}))

vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: detectTmuxPaneMock,
}))

vi.mock('../src/daemon/runtime-identity.js', () => ({
  bindRuntimeIdentity: bindRuntimeIdentityMock,
}))

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-register-client-route-'))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

describe('register_agent client routing', () => {
  const cleanups: string[] = []

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    registerCodexSelfMock.mockReset()
    detectTmuxPaneMock.mockReset()
    bindRuntimeIdentityMock.mockReset()
  })

  it('routes client=codex through the internal codex self-registration path', async () => {
    registerCodexSelfMock.mockResolvedValue({
      agent_id: 'agent-codex-1',
      team: 'default',
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: 'ws://127.0.0.1:8799',
    })
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
      arguments: {
        agent_type: 'codex',
        model: 'gpt-5',
        role: 'worker',
        name: 'alice',
        thread_id: '11111111-1111-4111-8111-111111111111',
      },
    })
    const obj = await parseTool(resp)

    expect(obj).toEqual({
      agent_id: 'agent-codex-1',
      team: 'default',
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: 'ws://127.0.0.1:8799',
    })
    expect(registerCodexSelfMock).toHaveBeenCalledWith({
      connection_id: expect.any(String),
      name: 'alice',
      model: 'gpt-5',
      role: 'worker',
      team: undefined,
      project_dir: undefined,
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: '',
      auth_token_ref: undefined,
    })
    expect(detectTmuxPaneMock).toHaveBeenCalledWith({ agent: 'codex' })

    await t.close()
    await c.close()
    await app.close()
  })
})
