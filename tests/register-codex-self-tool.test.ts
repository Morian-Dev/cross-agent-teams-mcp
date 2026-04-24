import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerBusinessTools } from '../src/mcp/tools.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import type { WebSocketLike } from '../src/mcp/codex-appserver-rpc.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-register-codex-self-tool-'))

const { detectTmuxPaneMock, webSocketFactoryMock } = vi.hoisted(() => ({
  detectTmuxPaneMock: vi.fn(),
  webSocketFactoryMock: vi.fn(),
}))

vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: detectTmuxPaneMock,
}))

vi.mock('../src/mcp/codex-appserver-rpc.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/mcp/codex-appserver-rpc.js')>()
  return {
    ...actual,
    defaultWebSocketFactory: (args: { url: string; headers?: Record<string, string> }) =>
      webSocketFactoryMock(args),
  }
})

type EventName = 'open' | 'message' | 'error' | 'close'
type JsonRpcMessage = { id?: number; method?: string; params?: unknown }

class MockWebSocket implements WebSocketLike {
  readonly listeners: Record<EventName, Set<(event: unknown) => void>> = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  }

  constructor(private readonly onSend: (message: JsonRpcMessage, ws: MockWebSocket) => void) {}

  addEventListener(type: EventName, listener: (event: unknown) => void): void {
    this.listeners[type].add(listener)
  }

  removeEventListener(type: EventName, listener: (event: unknown) => void): void {
    this.listeners[type].delete(listener)
  }

  send(data: string): void {
    this.onSend(JSON.parse(data) as JsonRpcMessage, this)
  }

  close(): void { /* noop */ }

  emit(type: EventName, event: unknown): void {
    for (const listener of this.listeners[type]) listener(event)
  }

  reply(id: number, payload: { result?: unknown; error?: unknown }): void {
    this.emit('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id, ...payload }),
    })
  }
}

function installCodexHappyPath(threadIds: string[]): void {
  webSocketFactoryMock.mockImplementation(() => {
    const ws = new MockWebSocket((message, socket) => {
      if (typeof message.id !== 'number') return
      if (message.method === 'initialize') {
        socket.reply(message.id, { result: { ok: true } })
      } else if (message.method === 'thread/loaded/list') {
        socket.reply(message.id, { result: { data: threadIds } })
      } else if (message.method === 'thread/resume') {
        socket.reply(message.id, { result: { ok: true } })
      }
    })
    queueMicrotask(() => ws.emit('open', {}))
    return ws
  })
}

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

describe('register_codex_self tool', () => {
  const cleanups: string[] = []

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    detectTmuxPaneMock.mockReset()
    webSocketFactoryMock.mockReset()
  })

  async function setup() {
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const db = openDb(dbPath)
    applySchema(db)
    const server = new McpServer({ name: 'test-server', version: '0.0.0' })
    const holder: { current: string | undefined } = { current: undefined }
    const sessionId = 'session-register-codex-self'
    registerBusinessTools(
      server,
      db,
      () => holder.current ?? sessionId,
      undefined,
      (agentId) => { holder.current = agentId },
      () => sessionId,
      undefined
    )
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'fake-codex', version: '0.124.0' })
    await client.connect(clientTransport)
    return { db, server, client, transport: clientTransport }
  }

  it('rejects ui_pid / tmux_pane_id / delivery / channel_session_id via strict schema', async () => {
    const { server, client, transport } = await setup()

    for (const forbiddenKey of ['ui_pid', 'tmux_pane_id', 'delivery', 'channel_session_id', 'base_url', 'session_id', 'claude_ui_pid']) {
      const args: Record<string, unknown> = { name: 'gpt', thread_id: '11111111-1111-4111-8111-111111111111' }
      args[forbiddenKey] = forbiddenKey === 'ui_pid' || forbiddenKey === 'claude_ui_pid'
        ? 42305
        : forbiddenKey === 'delivery'
          ? { kind: 'codex-appserver' }
          : 'forbidden'

      const resp = await client.callTool({
        name: 'register_codex_self',
        arguments: args,
      }) as { isError?: boolean; content: Array<{ text: string }> }
      expect(resp.isError).toBe(true)
      expect(resp.content[0].text).toMatch(/unrecognized_keys|Unrecognized key/)
      expect(resp.content[0].text).toContain(forbiddenKey)
    }

    await transport.close()
    await client.close()
    await server.close()
  })

  it('routes {name, thread_id, ws_url} through codex-appserver and returns delivery.kind parity', async () => {
    installCodexHappyPath(['11111111-1111-4111-8111-111111111111'])
    const { db, server, client, transport } = await setup()

    const result = await parseTool(await client.callTool({
      name: 'register_codex_self',
      arguments: {
        name: 'gpt',
        thread_id: '11111111-1111-4111-8111-111111111111',
        ws_url: 'ws://127.0.0.1:8799',
      },
    }))

    expect(result.agent_id).toBeDefined()
    expect(result.thread_id).toBe('11111111-1111-4111-8111-111111111111')
    expect(result.ws_url).toBe('ws://127.0.0.1:8799')

    const row = db.prepare(
      'SELECT client, delivery_kind, delivery_payload FROM agents WHERE team=? AND name=?'
    ).get('default', 'gpt') as {
      client: string | null
      delivery_kind: string
      delivery_payload: string | null
    }
    expect(row.client).toBe('codex')
    expect(row.delivery_kind).toBe('codex-appserver')
    expect(JSON.parse(row.delivery_payload as string)).toEqual({
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: 'ws://127.0.0.1:8799',
    })

    await transport.close()
    await client.close()
    await server.close()
  })

  it('returns thread_id_required envelope when thread_id is omitted and multiple candidates exist', async () => {
    installCodexHappyPath([
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ])
    const { server, client, transport } = await setup()

    const result = await parseTool(await client.callTool({
      name: 'register_codex_self',
      arguments: { name: 'gpt' },
    }))

    expect(result).toEqual({
      error: 'thread_id_required',
      detail: {
        ws_url: 'ws://127.0.0.1:8799',
        thread_ids: [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
        ],
      },
    })

    await transport.close()
    await client.close()
    await server.close()
  })

  it('produces the same registered agent row as register_agent({client:"codex",...})', async () => {
    installCodexHappyPath(['11111111-1111-4111-8111-111111111111'])
    const { db, server, client, transport } = await setup()

    // Self-registration via register_codex_self
    const selfResult = await parseTool(await client.callTool({
      name: 'register_codex_self',
      arguments: {
        name: 'gpt-self',
        thread_id: '11111111-1111-4111-8111-111111111111',
        ws_url: 'ws://127.0.0.1:8799',
      },
    }))
    expect(selfResult.agent_id).toBeDefined()
    const selfRow = db.prepare(
      'SELECT client, model, delivery_kind, delivery_payload FROM agents WHERE team=? AND name=?'
    ).get('default', 'gpt-self') as {
      client: string
      model: string
      delivery_kind: string
      delivery_payload: string | null
    }

    // Parallel registration via register_agent with equivalent args
    const agentResult = await parseTool(await client.callTool({
      name: 'register_agent',
      arguments: {
        client: 'codex',
        model: 'gpt',
        name: 'gpt-generic',
        thread_id: '11111111-1111-4111-8111-111111111111',
        ws_url: 'ws://127.0.0.1:8799',
      },
    }))
    expect(agentResult.agent_id).toBeDefined()
    const agentRow = db.prepare(
      'SELECT client, model, delivery_kind, delivery_payload FROM agents WHERE team=? AND name=?'
    ).get('default', 'gpt-generic') as {
      client: string
      model: string
      delivery_kind: string
      delivery_payload: string | null
    }

    expect(selfRow.client).toBe(agentRow.client)
    expect(selfRow.model).toBe(agentRow.model)
    expect(selfRow.delivery_kind).toBe(agentRow.delivery_kind)
    expect(JSON.parse(selfRow.delivery_payload as string)).toEqual(JSON.parse(agentRow.delivery_payload as string))

    await transport.close()
    await client.close()
    await server.close()
  })

  it('description string mentions CODEX_THREAD_ID and pre_register_codex_pane and does not recommend ui_pid', async () => {
    const { server, client, transport } = await setup()

    const toolsList = await client.listTools()
    const tool = toolsList.tools.find(t => t.name === 'register_codex_self')
    expect(tool).toBeDefined()
    const description = tool!.description ?? ''
    expect(description).toContain('CODEX_THREAD_ID')
    expect(description).toContain('pre_register_codex_pane')
    // `ui_pid` may only appear in a negation / warning; the description must
    // NOT recommend passing it. A simple proxy: whenever it appears, it should
    // appear alongside a "DO NOT" / "rejects" marker.
    if (description.includes('ui_pid')) {
      expect(description).toMatch(/DO NOT pass `ui_pid`|schema rejects it/)
    }

    await transport.close()
    await client.close()
    await server.close()
  })
})
