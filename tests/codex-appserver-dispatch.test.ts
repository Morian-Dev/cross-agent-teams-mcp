import { describe, it, expect } from 'vitest'
import {
  dispatchCodexAppserverPoke,
  type WebSocketLike,
} from '../src/mcp/codex-appserver-dispatch.js'

const THREAD_ID = '11111111-1111-4111-8111-111111111111'
const DELIVERY = {
  kind: 'codex-appserver' as const,
  thread_id: THREAD_ID,
  ws_url: 'ws://127.0.0.1:8799',
}

type EventName = 'open' | 'message' | 'error' | 'close'
type JsonRpcMessage = { id?: number; method?: string; params?: unknown }

class MockWebSocket implements WebSocketLike {
  readonly sent: JsonRpcMessage[] = []
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
    const message = JSON.parse(data) as JsonRpcMessage
    this.sent.push(message)
    this.onSend(message, this)
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
  const sockets: MockWebSocket[] = []
  return {
    calls,
    sockets,
    factory: ({ url, headers }: { url: string; headers?: Record<string, string> }) => {
      const ws = new MockWebSocket(args.onSend)
      calls.push({ url, headers })
      sockets.push(ws)
      args.onCreate?.(ws)
      return ws
    },
  }
}

describe('dispatchCodexAppserverPoke', () => {
  it('returns codex-appserver success after initialize, initialized, resume, and turn/start', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => {
        if (message.method === 'initialize' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
        if (message.method === 'thread/resume' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
        if (message.method === 'turn/start' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
      },
    })

    const result = await dispatchCodexAppserverPoke(
      { delivery: DELIVERY, content: 'hello from daemon' },
      { webSocketFactory: harness.factory, env: {} }
    )

    expect(result).toEqual({
      ok: true,
      transport_used: 'codex-appserver',
      thread_id: THREAD_ID,
    })
    expect(harness.calls).toEqual([
      { url: 'ws://127.0.0.1:8799', headers: undefined },
    ])
    expect(harness.sockets[0]?.sent.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'thread/resume',
      'turn/start',
    ])
    expect(harness.sockets[0]?.sent[3]).toMatchObject({
      method: 'turn/start',
      params: {
        threadId: THREAD_ID,
        input: [{ type: 'text', text: 'hello from daemon', text_elements: [] }],
      },
    })
    expect(harness.sockets[0]?.closeCalls).toBe(1)
  })

  it('resolves auth token from env and sends bearer Authorization header', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => {
        if (typeof message.id === 'number') {
          ws.reply(message.id, { result: { ok: true } })
        }
      },
    })

    const result = await dispatchCodexAppserverPoke(
      {
        delivery: {
          ...DELIVERY,
          auth_token_ref: 'CODEX_REMOTE_TOKEN',
        },
        content: 'hello',
      },
      {
        webSocketFactory: harness.factory,
        env: { CODEX_REMOTE_TOKEN: 'secret-token' },
      }
    )

    expect(result).toMatchObject({ ok: true, transport_used: 'codex-appserver' })
    expect(harness.calls).toEqual([
      {
        url: 'ws://127.0.0.1:8799',
        headers: { Authorization: 'Bearer secret-token' },
      },
    ])
  })

  it('returns missing_auth_token before websocket connect when auth_token_ref is unset', async () => {
    const harness = createHarness({
      onSend: () => undefined,
    })

    const result = await dispatchCodexAppserverPoke(
      {
        delivery: {
          ...DELIVERY,
          auth_token_ref: 'CODEX_REMOTE_TOKEN',
        },
        content: 'hello',
      },
      { webSocketFactory: harness.factory, env: {} }
    )

    expect(result).toEqual({
      error: 'missing_auth_token',
      detail: { ref: 'CODEX_REMOTE_TOKEN' },
    })
    expect(harness.calls).toHaveLength(0)
  })

  it('maps websocket dial failure to codex_connect_failed', async () => {
    const harness = createHarness({
      onCreate: (ws) =>
        queueMicrotask(() => ws.emit('error', { message: 'ECONNREFUSED' })),
      onSend: () => undefined,
    })

    const result = await dispatchCodexAppserverPoke(
      { delivery: DELIVERY, content: 'hello' },
      { webSocketFactory: harness.factory, env: {} }
    )

    expect(result).toEqual({
      error: 'codex_connect_failed',
      detail: 'ECONNREFUSED',
      transport_used: 'codex-appserver',
    })
    expect(harness.sockets[0]?.closeCalls).toBe(1)
  })

  it('maps initialize RPC failure to codex_initialize_failed', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => {
        if (message.method === 'initialize' && message.id) {
          ws.reply(message.id, {
            error: { code: -32000, message: 'initialize failed' },
          })
        }
      },
    })

    const result = await dispatchCodexAppserverPoke(
      { delivery: DELIVERY, content: 'hello' },
      { webSocketFactory: harness.factory, env: {} }
    )

    expect(result).toEqual({
      error: 'codex_initialize_failed',
      detail: { code: -32000, message: 'initialize failed' },
      transport_used: 'codex-appserver',
    })
    expect(harness.sockets[0]?.closeCalls).toBe(1)
  })

  it('maps thread/resume RPC failure to codex_resume_failed', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => {
        if (message.method === 'initialize' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
        if (message.method === 'thread/resume' && message.id) {
          ws.reply(message.id, {
            error: { code: -32001, message: 'resume failed' },
          })
        }
      },
    })

    const result = await dispatchCodexAppserverPoke(
      { delivery: DELIVERY, content: 'hello' },
      { webSocketFactory: harness.factory, env: {} }
    )

    expect(result).toEqual({
      error: 'codex_resume_failed',
      detail: { code: -32001, message: 'resume failed' },
      transport_used: 'codex-appserver',
    })
    expect(harness.sockets[0]?.closeCalls).toBe(1)
  })

  it('maps turn/start RPC failure to codex_turn_start_failed', async () => {
    const harness = createHarness({
      onCreate: (ws) => queueMicrotask(() => ws.emit('open', {})),
      onSend: (message, ws) => {
        if (message.method === 'initialize' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
        if (message.method === 'thread/resume' && message.id) {
          ws.reply(message.id, { result: { ok: true } })
        }
        if (message.method === 'turn/start' && message.id) {
          ws.reply(message.id, {
            error: { code: -32002, message: 'turn start failed' },
          })
        }
      },
    })

    const result = await dispatchCodexAppserverPoke(
      { delivery: DELIVERY, content: 'hello' },
      { webSocketFactory: harness.factory, env: {} }
    )

    expect(result).toEqual({
      error: 'codex_turn_start_failed',
      detail: { code: -32002, message: 'turn start failed' },
      transport_used: 'codex-appserver',
    })
    expect(harness.sockets[0]?.closeCalls).toBe(1)
  })
})
