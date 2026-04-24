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

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-register-opencode-self-'))

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

describe('register_opencode_self tool', () => {
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
    const sessionId = 'session-register-opencode-self'
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
    return { db, dbPath, server, client, transport: clientTransport }
  }

  it('rejects missing name', async () => {
    const { server, client, transport } = await setup()
    const resp = await client.callTool({
      name: 'register_opencode_self',
      arguments: {},
    }) as { isError?: boolean; content: Array<{ text: string }> }
    expect(resp.isError).toBe(true)
    expect(resp.content[0].text).toMatch(/name/i)
    await transport.close(); await client.close(); await server.close()
  })

  it('rejects forbidden keys via strict schema', async () => {
    const { server, client, transport } = await setup()
    for (const forbidden of ['ui_pid', 'channel_session_id', 'delivery', 'base_url', 'session_id', 'thread_id', 'claude_ui_pid']) {
      const args: Record<string, unknown> = { name: 'glm' }
      args[forbidden] = forbidden === 'ui_pid' || forbidden === 'claude_ui_pid'
        ? 42305
        : forbidden === 'delivery'
          ? { kind: 'opencode-server' }
          : 'forbidden'
      const resp = await client.callTool({
        name: 'register_opencode_self',
        arguments: args,
      }) as { isError?: boolean; content: Array<{ text: string }> }
      expect(resp.isError).toBe(true)
      expect(resp.content[0].text).toMatch(/unrecognized_keys|Unrecognized key/)
      expect(resp.content[0].text).toContain(forbidden)
    }
    await transport.close(); await client.close(); await server.close()
  })

  it('defaults model to "opencode" and team to "default" when neither team nor project_dir given', async () => {
    const { db, server, client, transport } = await setup()
    const result = await parseTool(await client.callTool({
      name: 'register_opencode_self',
      arguments: { name: 'glm' },
    }))
    expect(result.agent_id).toBeDefined()
    const row = db.prepare(
      'SELECT client, team, model FROM agents WHERE name=?'
    ).get('glm') as { client: string; team: string; model: string }
    expect(row.client).toBe('opencode')
    expect(row.team).toBe('default')
    expect(row.model).toBe('opencode')
    await transport.close(); await client.close(); await server.close()
  })

  it('derives team from project_dir basename when team omitted', async () => {
    const { db, server, client, transport } = await setup()
    await parseTool(await client.callTool({
      name: 'register_opencode_self',
      arguments: { name: 'glm', project_dir: '/Users/jt/workspace/cross-agent-teams-mcp' },
    }))
    const row = db.prepare('SELECT team FROM agents WHERE name=?').get('glm') as { team: string }
    expect(row.team).toBe('cross-agent-teams-mcp')
    await transport.close(); await client.close(); await server.close()
  })

  it('explicit team wins over project_dir', async () => {
    const { db, server, client, transport } = await setup()
    await parseTool(await client.callTool({
      name: 'register_opencode_self',
      arguments: { name: 'glm', team: 'alpha', project_dir: '/Users/jt/workspace/some-repo' },
    }))
    const row = db.prepare('SELECT team FROM agents WHERE name=?').get('glm') as { team: string }
    expect(row.team).toBe('alpha')
    await transport.close(); await client.close(); await server.close()
  })

  it('description mentions pre_register_opencode_pane', async () => {
    const { server, client, transport } = await setup()
    const toolsList = await client.listTools()
    const tool = toolsList.tools.find(t => t.name === 'register_opencode_self')
    expect(tool).toBeDefined()
    const description = tool!.description ?? ''
    expect(description).toContain('pre_register_opencode_pane')
    await transport.close(); await client.close(); await server.close()
  })

  it('auto-binds opencode_base_url + opencode_session_id from live pre-reg row (and deletes the row)', async () => {
    opencodeOverrides.listPanes = async () => [{ pane_id: '%2018', tty: 'ttys004' }]
    opencodeOverrides.ttyProcesses = async () => ['55555 1 Ss opencode']

    const { db, server, client, transport } = await setup()

    // Launcher first pre-registers the pane
    const preReg = await client.callTool({
      name: 'pre_register_opencode_pane',
      arguments: {
        pane_id: '%2018',
        base_url: 'http://127.0.0.1:4096',
        session_id: 'ses_auto',
      },
    })
    expect(await parseTool(preReg)).toMatchObject({ ok: true })

    // Now register_opencode_self should consume it
    const result = await parseTool(await client.callTool({
      name: 'register_opencode_self',
      arguments: { name: 'glm', project_dir: '/Users/jt/workspace/xats' },
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

  it('no matching pre-reg → fields NULL, no error', async () => {
    opencodeOverrides.listPanes = async () => []
    opencodeOverrides.ttyProcesses = async () => []

    const { db, server, client, transport } = await setup()

    const result = await parseTool(await client.callTool({
      name: 'register_opencode_self',
      arguments: { name: 'glm' },
    }))
    expect(result.agent_id).toBeDefined()

    const row = db.prepare(
      'SELECT opencode_base_url, opencode_session_id FROM agents WHERE name=?'
    ).get('glm') as { opencode_base_url: string | null; opencode_session_id: string | null }
    expect(row.opencode_base_url).toBeNull()
    expect(row.opencode_session_id).toBeNull()

    await transport.close(); await client.close(); await server.close()
  })

  it('expired pre-reg is purged and does not auto-bind', async () => {
    opencodeOverrides.listPanes = async () => [{ pane_id: '%EXP', tty: 'ttys004' }]
    opencodeOverrides.ttyProcesses = async () => ['55555 1 Ss opencode']

    const { db, dbPath, server, client, transport } = await setup()

    // Seed an already-expired pre-reg directly
    {
      const d = openDb(dbPath)
      applySchema(d)
      d.prepare(
        `INSERT INTO opencode_pane_pre_registrations (pane_id, base_url, session_id, expires_at)
         VALUES (?, ?, ?, ?)`
      ).run('%EXP', 'http://127.0.0.1:4096', 'ses_exp', '2000-01-01T00:00:00.000Z')
      d.close()
    }

    const result = await parseTool(await client.callTool({
      name: 'register_opencode_self',
      arguments: { name: 'glm' },
    }))
    expect(result.agent_id).toBeDefined()

    const row = db.prepare(
      'SELECT opencode_base_url FROM agents WHERE name=?'
    ).get('glm') as { opencode_base_url: string | null }
    expect(row.opencode_base_url).toBeNull()

    const preCount = (db.prepare(
      'SELECT COUNT(*) AS c FROM opencode_pane_pre_registrations'
    ).get() as { c: number }).c
    expect(preCount).toBe(0)

    await transport.close(); await client.close(); await server.close()
  })

  it('second register_opencode_self with no new pre-reg reverts fields to NULL', async () => {
    let listPanesCalls = 0
    opencodeOverrides.listPanes = async () => {
      listPanesCalls += 1
      return [{ pane_id: '%2018', tty: 'ttys004' }]
    }
    opencodeOverrides.ttyProcesses = async () => ['55555 1 Ss opencode']

    const { db, server, client, transport } = await setup()

    // First pre-reg + register
    await client.callTool({
      name: 'pre_register_opencode_pane',
      arguments: {
        pane_id: '%2018',
        base_url: 'http://127.0.0.1:4096',
        session_id: 'ses_once',
      },
    })
    await parseTool(await client.callTool({
      name: 'register_opencode_self',
      arguments: { name: 'glm' },
    }))
    const firstRow = db.prepare(
      'SELECT opencode_base_url, opencode_session_id FROM agents WHERE name=?'
    ).get('glm') as { opencode_base_url: string | null; opencode_session_id: string | null }
    expect(firstRow.opencode_base_url).toBe('http://127.0.0.1:4096')

    // Second register without a new pre-reg -> fields must revert
    await parseTool(await client.callTool({
      name: 'register_opencode_self',
      arguments: { name: 'glm' },
    }))
    const secondRow = db.prepare(
      'SELECT opencode_base_url, opencode_session_id FROM agents WHERE name=?'
    ).get('glm') as { opencode_base_url: string | null; opencode_session_id: string | null }
    expect(secondRow.opencode_base_url).toBeNull()
    expect(secondRow.opencode_session_id).toBeNull()

    expect(listPanesCalls).toBeGreaterThanOrEqual(1)

    await transport.close(); await client.close(); await server.close()
  })
})
