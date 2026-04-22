import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ChannelWakeFanout } from '../src/daemon/channel-wake-fanout.js'
import { registerBusinessTools } from '../src/mcp/tools.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-register-claude-self-'))
const { detectTmuxPaneMock } = vi.hoisted(() => ({
  detectTmuxPaneMock: vi.fn(),
}))

vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: detectTmuxPaneMock,
}))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const result = resp as { content: Array<{ text: string }> }
  return JSON.parse(result.content[0].text)
}

describe('register_claude_self tool', () => {
  const cleanups: string[] = []

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    detectTmuxPaneMock.mockReset()
  })

  async function setup(channelWakeFanout?: ChannelWakeFanout) {
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const db = openDb(dbPath)
    applySchema(db)
    const server = new McpServer({ name: 'test-server', version: '0.0.0' })
    const holder: { current: string | undefined } = { current: undefined }
    const sessionId = 'session-register-claude-self'
    registerBusinessTools(
      server,
      db,
      () => holder.current ?? sessionId,
      undefined,
      (agentId) => { holder.current = agentId },
      () => sessionId,
      channelWakeFanout
    )
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'fake-claude-code', version: '1.2.3' })
    await client.connect(clientTransport)
    return { db, server, client, transport: clientTransport }
  }

  it('registers the current session as claude-code and immediately enables follow-up tools', async () => {
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    const channelWakeFanout = new ChannelWakeFanout()
    channelWakeFanout.attach('csid-abc', () => { /* sink */ }, 'sess-proxy')
    const { db, server, client, transport } = await setup(channelWakeFanout)

    const result = await parseTool(await client.callTool({
      name: 'register_claude_self',
      arguments: {
        name: 'alice',
        channel_session_id: 'csid-abc',
      },
    }))
    expect(result.agent_id).toBeDefined()

    const row = db.prepare(
      `SELECT model, client, delivery_kind, delivery_payload FROM agents WHERE team='default' AND name='alice'`
    ).get() as {
      model: string
      client: string | null
      delivery_kind: string
      delivery_payload: string | null
    }
    expect(row.model).toBe('claude-code')
    expect(row.client).toBe('claude-code')
    expect(row.delivery_kind).toBe('claude-channel')
    expect(JSON.parse(row.delivery_payload as string)).toEqual({
      channel_session_id: 'csid-abc',
    })

    const inbox = await parseTool(await client.callTool({
      name: 'get_inbox',
      arguments: {},
    }))
    expect(inbox).toEqual({
      messages: [],
      has_more: false,
      last_event_id: 0,
    })

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })
})
