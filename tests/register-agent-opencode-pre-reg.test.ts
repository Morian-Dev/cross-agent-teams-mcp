import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerBusinessTools } from '../src/mcp/tools.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { __testOverrides as opencodeOverrides } from '../src/mcp/auto-bind-opencode-pane.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-register-agent-opencode-pre-reg-'))

const { detectTmuxPaneMock } = vi.hoisted(() => ({
  detectTmuxPaneMock: vi.fn(),
}))

vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: detectTmuxPaneMock,
}))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

function resetOpencodeOverrides(): void {
  delete opencodeOverrides.listPanes
  delete opencodeOverrides.ttyProcesses
  delete opencodeOverrides.now
}

describe('register_agent client=opencode pre-reg auto-bind', () => {
  const cleanups: string[] = []

  beforeEach(() => {
    detectTmuxPaneMock.mockReset()
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    resetOpencodeOverrides()
  })

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    resetOpencodeOverrides()
  })

  async function setup() {
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const db = openDb(dbPath)
    applySchema(db)
    const server = new McpServer({ name: 'test-server', version: '0.0.0' })
    const holder: { current: string | undefined } = { current: undefined }
    const sessionId = 'session-register-agent-opencode-pre-reg'
    registerBusinessTools(
      server,
      db,
      () => holder.current ?? sessionId,
      undefined,
      (agentId) => { holder.current = agentId },
      () => sessionId,
      undefined,
    )
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'fake-opencode', version: '1.14.19' })
    await client.connect(clientTransport)
    return { db, server, client, transport: clientTransport }
  }

  it('auto-binds via pre-reg when register_agent({client:"opencode"}) omits base_url/session_id', async () => {
    opencodeOverrides.listPanes = async () => [{ pane_id: '%2018', tty: 'ttys004' }]
    opencodeOverrides.ttyProcesses = async () => ['55555 1 Ss opencode']

    const { db, server, client, transport } = await setup()

    const preReg = await client.callTool({
      name: 'pre_register_opencode_pane',
      arguments: {
        pane_id: '%2018',
        base_url: 'http://127.0.0.1:4096',
        session_id: 'ses_auto',
      },
    })
    expect(await parseTool(preReg)).toMatchObject({ ok: true })

    const result = await parseTool(await client.callTool({
      name: 'register_agent',
      arguments: {
        client: 'opencode',
        model: 'glm-5.1',
        name: 'glm',
        project_dir: '/Users/jt/workspace/cross-agent-teams-mcp',
      },
    }))
    expect(result.agent_id).toBeDefined()

    const row = db.prepare(
      'SELECT client, opencode_base_url, opencode_session_id FROM agents WHERE name=?'
    ).get('glm') as { client: string; opencode_base_url: string | null; opencode_session_id: string | null }
    expect(row.client).toBe('opencode')
    expect(row.opencode_base_url).toBe('http://127.0.0.1:4096')
    expect(row.opencode_session_id).toBe('ses_auto')

    const preCount = (db.prepare(
      'SELECT COUNT(*) AS c FROM opencode_pane_pre_registrations'
    ).get() as { c: number }).c
    expect(preCount).toBe(0)

    await transport.close(); await client.close(); await server.close()
  })

  it('explicit base_url + session_id wins and leaves pre-reg row untouched', async () => {
    opencodeOverrides.listPanes = async () => [{ pane_id: '%2018', tty: 'ttys004' }]
    opencodeOverrides.ttyProcesses = async () => ['55555 1 Ss opencode']

    const { db, server, client, transport } = await setup()

    await client.callTool({
      name: 'pre_register_opencode_pane',
      arguments: {
        pane_id: '%2018',
        base_url: 'http://127.0.0.1:4096',
        session_id: 'ses_from_prereg',
      },
    })

    const result = await parseTool(await client.callTool({
      name: 'register_agent',
      arguments: {
        client: 'opencode',
        model: 'glm-5.1',
        name: 'glm',
        base_url: 'http://127.0.0.1:4096',
        session_id: 'ses_explicit',
      },
    }))
    expect(result.agent_id).toBeDefined()

    const row = db.prepare(
      'SELECT opencode_base_url, opencode_session_id FROM agents WHERE name=?'
    ).get('glm') as { opencode_base_url: string | null; opencode_session_id: string | null }
    expect(row.opencode_session_id).toBe('ses_explicit')

    // pre-reg row must still be present (untouched)
    const preRow = db.prepare(
      'SELECT pane_id, session_id FROM opencode_pane_pre_registrations'
    ).get() as { pane_id: string; session_id: string } | undefined
    expect(preRow).toEqual({ pane_id: '%2018', session_id: 'ses_from_prereg' })

    await transport.close(); await client.close(); await server.close()
  })

  it('register_agent description contains opencode-launcher hint pointing at register_opencode_self', async () => {
    const { server, client, transport } = await setup()
    const toolsList = await client.listTools()
    const tool = toolsList.tools.find(t => t.name === 'register_agent')
    expect(tool).toBeDefined()
    const description = tool!.description ?? ''
    expect(description).toContain('register_opencode_self')
    expect(description).toMatch(/xats opencode launcher|opencode launcher/i)
    await transport.close(); await client.close(); await server.close()
  })
})
