import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { RegisterAgentService } from '../src/mcp/register-agent.js'
import { RegisterCodexSelfService } from '../src/mcp/register-codex-self.js'
import type { WebSocketLike } from '../src/mcp/codex-appserver-rpc.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-register-codex-self-'))

type EventName = 'open' | 'message' | 'error' | 'close'
type JsonRpcMessage = { id?: number; method?: string; params?: unknown }

class MockWebSocket implements WebSocketLike {
  readonly listeners: Record<EventName, Set<(event: unknown) => void>> = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  }
  closeCalls = 0

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

  close(): void {
    this.closeCalls += 1
  }

  emit(type: EventName, event: unknown): void {
    for (const listener of this.listeners[type]) {
      listener(event)
    }
  }

  reply(id: number, payload: { result?: unknown; error?: unknown }): void {
    this.emit('message', {
      data: JSON.stringify({ jsonrpc: '2.0', id, ...payload }),
    })
  }
}

function createHarness(args: {
  onCreate?: (ws: MockWebSocket) => void
  onSend: (message: JsonRpcMessage, ws: MockWebSocket) => void
}) {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = []
  return {
    calls,
    factory: ({ url, headers }: { url: string; headers?: Record<string, string> }) => {
      const ws = new MockWebSocket(args.onSend)
      calls.push({ url, headers })
      args.onCreate?.(ws)
      return ws
    },
  }
}

describe('RegisterCodexSelfService', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  function setup(harness: ReturnType<typeof createHarness>, env: NodeJS.ProcessEnv = {}) {
    const dir = tmp()
    cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const registerSvc = new RegisterAgentService(db)
    const svc = new RegisterCodexSelfService(registerSvc, {
      webSocketFactory: harness.factory,
      env,
    })
    return { db, svc }
  }

  it('autodetects the single resumable thread and registers codex delivery', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => {
        if (message.method === 'initialize' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
        if (message.method === 'thread/loaded/list' && message.id) {
          ws.reply(message.id, {
            result: { data: ['11111111-1111-4111-8111-111111111111'] },
          })
        }
        if (message.method === 'thread/resume' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
      },
    })
    const { db, svc } = setup(harness)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
      team: 'default',
      role: 'worker',
    })

    expect(result).toEqual({
      agent_id: expect.any(String),
      team: 'default',
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: 'ws://127.0.0.1:8799',
    })
    const row = db.prepare(
      'SELECT delivery_kind, delivery_payload FROM agents WHERE team=? AND name=?'
    ).get('default', 'lead') as {
      delivery_kind: string
      delivery_payload: string | null
    }
    expect(row.delivery_kind).toBe('codex-appserver')
    expect(JSON.parse(row.delivery_payload as string)).toEqual({
      thread_id: '11111111-1111-4111-8111-111111111111',
      ws_url: 'ws://127.0.0.1:8799',
    })
  })

  it('returns no_loaded_threads when app-server reports none', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => {
        if (typeof message.id === 'number') {
          if (message.method === 'thread/loaded/list') {
            ws.reply(message.id, { result: { data: [] } })
          } else {
            ws.reply(message.id, { result: { ok: true } })
          }
        }
      },
    })
    const { svc } = setup(harness)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
    })

    expect(result).toEqual({
      error: 'no_loaded_threads',
      detail: { ws_url: 'ws://127.0.0.1:8799' },
    })
  })

  it('returns ambiguous_loaded_threads when multiple threads are resumable', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => {
        if (message.method === 'initialize' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
        if (message.method === 'thread/loaded/list' && message.id) {
          ws.reply(message.id, {
            result: {
              data: [
                '11111111-1111-4111-8111-111111111111',
                '22222222-2222-4222-8222-222222222222',
              ],
            },
          })
        }
        if (message.method === 'thread/resume' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
      },
    })
    const { svc } = setup(harness)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
    })

    expect(result).toEqual({
      error: 'ambiguous_loaded_threads',
      detail: {
        thread_ids: [
          '11111111-1111-4111-8111-111111111111',
          '22222222-2222-4222-8222-222222222222',
        ],
      },
    })
  })

  it('returns missing_auth_token when auth_token_ref is set but env is missing', async () => {
    const harness = createHarness({
      onSend: () => undefined,
    })
    const { svc } = setup(harness)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
      auth_token_ref: 'CODEX_REMOTE_TOKEN',
    })

    expect(result).toEqual({
      error: 'missing_auth_token',
      detail: { ref: 'CODEX_REMOTE_TOKEN' },
    })
  })

  it('returns unsupported_client when app-server is unreachable', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('error', { message: 'ECONNREFUSED' })),
      onSend: () => undefined,
    })
    const { svc } = setup(harness)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
    })

    expect(result).toEqual({
      error: 'unsupported_client',
      detail: {
        expected: 'codex',
        reason: 'codex_appserver_unreachable',
        ws_url: 'ws://127.0.0.1:8799',
        cause: 'ECONNREFUSED',
      },
    })
  })

  it('returns unsupported_client when websocket endpoint does not speak codex protocol', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => {
        if (message.method === 'initialize' && message.id) {
          ws.reply(message.id, {
            error: { code: -32601, message: 'method not found' },
          })
        }
      },
    })
    const { svc } = setup(harness)

    const result = await svc.register({
      connection_id: 'conn-1',
      name: 'lead',
    })

    expect(result).toEqual({
      error: 'unsupported_client',
      detail: {
        expected: 'codex',
        reason: 'codex_protocol_unavailable',
        ws_url: 'ws://127.0.0.1:8799',
        cause: { code: -32601, message: 'method not found' },
      },
    })
  })
})
