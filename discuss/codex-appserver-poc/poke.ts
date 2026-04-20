#!/usr/bin/env tsx
// POC: poke a running Codex TUI session via app-server ws.
// Requires an app-server listening on loopback and a TUI connected via --remote.

type Json = unknown

interface JsonRpcRequest { jsonrpc: '2.0'; id: number; method: string; params: Json }
interface JsonRpcResponse { jsonrpc: '2.0'; id: number; result?: Json; error?: { code: number; message: string; data?: Json } }
interface JsonRpcNotification { jsonrpc: '2.0'; method: string; params?: Json }

const WS_URL = process.env.APP_SERVER_URL ?? 'ws://127.0.0.1:8799'
const THREAD_ARG = process.argv[2]
const POKE_TEXT = process.argv[3] ?? 'POC poke from external client'

function main(): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL)
    const pending = new Map<number, (r: JsonRpcResponse) => void>()
    let nextId = 1

    const send = (method: string, params: Json): Promise<JsonRpcResponse> => {
      const id = nextId++
      const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
      return new Promise((res) => {
        pending.set(id, res)
        ws.send(JSON.stringify(req))
        log('→', method, params)
      })
    }

    const notify = (method: string, params?: Json): void => {
      const n: JsonRpcNotification = { jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) }
      ws.send(JSON.stringify(n))
      log('→', method, '(notification)')
    }

    const log = (...args: unknown[]): void => {
      // eslint-disable-next-line no-console
      console.log(...args)
    }

    ws.addEventListener('message', (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : ''
      let msg: JsonRpcResponse | JsonRpcNotification
      try { msg = JSON.parse(raw) } catch { log('! non-JSON frame:', raw); return }
      if ('id' in msg && msg.id != null) {
        const resolver = pending.get(msg.id as number)
        if (resolver) { pending.delete(msg.id as number); resolver(msg as JsonRpcResponse); return }
      }
      const notif = msg as JsonRpcNotification
      if (notif.method === 'item/agentMessage/delta' || notif.method === 'turn/started'
          || notif.method === 'turn/completed' || notif.method === 'thread/started'
          || notif.method === 'item/started' || notif.method === 'item/completed'
          || notif.method === 'error') {
        log('←', notif.method, summarize(notif.params))
      }
    })

    ws.addEventListener('error', (e: Event) => reject(new Error('ws error: ' + String(e))))
    ws.addEventListener('close', () => log('ws closed'))

    ws.addEventListener('open', async () => {
      try {
        const init = await send('initialize', {
          clientInfo: { name: 'codex-appserver-poke-poc', title: null, version: '0.0.1' },
          capabilities: { experimentalApi: true, optOutNotificationMethods: null }
        })
        if (init.error) throw new Error('initialize failed: ' + init.error.message)

        notify('initialized')

        let threadId = THREAD_ARG
        if (!threadId) {
          const list = await send('thread/loaded/list', { cursor: null, limit: 10 })
          if (list.error) throw new Error('thread/loaded/list failed: ' + list.error.message)
          const data = (list.result as { data?: string[] } | undefined)?.data ?? []
          if (data.length === 0) throw new Error('no loaded threads; open a TUI with --remote first')
          threadId = data[0]
          log('• picked loaded threadId:', threadId, '(of', data.length, ')')
        }

        const resume = await send('thread/resume', {
          threadId,
          persistExtendedHistory: false
        })
        if (resume.error) throw new Error('thread/resume failed: ' + resume.error.message)
        log('✓ thread/resume ok; subscribed to turn/item events.')

        const turn = await send('turn/start', {
          threadId,
          input: [{ type: 'text', text: POKE_TEXT, text_elements: [] }]
        })
        if (turn.error) throw new Error('turn/start failed: ' + turn.error.message)
        log('✓ turn/start accepted; watching events. Ctrl-C when satisfied.')

        setTimeout(() => { ws.close(); resolve() }, 30_000)
      } catch (err) {
        reject(err as Error)
      }
    })
  })
}

function summarize(params: unknown): unknown {
  if (!params || typeof params !== 'object') return params
  const p = params as Record<string, unknown>
  const delta = typeof p.delta === 'string' ? p.delta.slice(0, 80) + (p.delta.length > 80 ? '…' : '') : undefined
  if (delta !== undefined) return { delta }
  return p
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('FAIL:', e.message)
  process.exit(1)
})
