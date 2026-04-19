import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

export interface RegistrationConfig {
  daemonUrl: string
  team: string
  name: string
  channel_session_id: string
  backoffInitialMs?: number
  backoffMaxMs?: number
  notificationHandler?: (payload: unknown) => void
}

export interface ReconnectingProxyConfig extends RegistrationConfig {
  onSequenceComplete?: (order: string[]) => void
  onDisconnect?: () => void
  healthCheckIntervalMs?: number
}

export interface ReconnectingProxyController {
  stop(): Promise<void>
}

export interface RegistrationSequenceResult {
  order: string[]
  bindAttempts: number
  lastBindResult: unknown
  lastSubscribeResult: unknown
  client: Client
  transport: StreamableHTTPClientTransport
  close: () => Promise<void>
}

type ToolResult = Record<string, unknown>

async function parseToolResult(resp: unknown): Promise<ToolResult> {
  const r = resp as { content?: Array<{ text?: string }> }
  const text = r.content?.[0]?.text
  if (typeof text !== 'string') return {}
  try { return JSON.parse(text) as ToolResult } catch { return {} }
}

async function sleepJittered(baseMs: number): Promise<void> {
  const jitterPct = 0.15
  const factor = 1 + (Math.random() * 2 - 1) * jitterPct
  return new Promise(resolve => setTimeout(resolve, Math.floor(baseMs * factor)))
}

export async function runRegistrationSequence(
  config: RegistrationConfig
): Promise<RegistrationSequenceResult> {
  const order: string[] = []
  const transport = new StreamableHTTPClientTransport(new URL(config.daemonUrl))
  const client = new Client({ name: 'ts-agent-teams-channel-proxy', version: '0.1.0' })

  if (config.notificationHandler) {
    client.fallbackNotificationHandler = async (n) => {
      if (n.method === 'notifications/channel_wake') {
        config.notificationHandler!(n.params)
      }
    }
  }

  await client.connect(transport)

  // 1. register_agent as proxy
  const registerResp = await client.callTool({
    name: 'register_agent',
    arguments: {
      model: 'proxy',
      role: '__channel_proxy__',
      name: `channel-proxy-${process.pid}-${Math.floor(Math.random() * 1e6)}`,
      team: 'default'
    }
  })
  order.push('register_agent')
  const regResult = await parseToolResult(registerResp)
  if (!('agent_id' in regResult)) {
    throw new Error(`register_agent failed: ${JSON.stringify(regResult)}`)
  }

  // 2. bind_channel with exponential backoff
  const initial = config.backoffInitialMs ?? 500
  const max = config.backoffMaxMs ?? 30_000
  let delayMs = initial
  let bindResult: ToolResult
  const maxAttempts = 20
  let bindAttempts = 0
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    bindAttempts++
    const resp = await client.callTool({
      name: 'bind_channel',
      arguments: {
        team: config.team,
        name: config.name,
        channel_session_id: config.channel_session_id
      }
    })
    bindResult = await parseToolResult(resp)
    if ('ok' in bindResult && bindResult.ok === true) break
    if (bindResult.error !== 'agent_not_registered') {
      throw new Error(`bind_channel failed: ${JSON.stringify(bindResult)}`)
    }
    await sleepJittered(delayMs)
    delayMs = Math.min(delayMs * 2, max)
    if (attempt === maxAttempts - 1) {
      throw new Error('bind_channel retries exhausted')
    }
  }
  order.push('bind_channel')

  // 3. subscribe_channel_wake
  const subResp = await client.callTool({
    name: 'subscribe_channel_wake',
    arguments: { channel_session_id: config.channel_session_id }
  })
  order.push('subscribe_channel_wake')
  const subResult = await parseToolResult(subResp)

  return {
    order,
    bindAttempts,
    lastBindResult: bindResult!,
    lastSubscribeResult: subResult,
    client,
    transport,
    close: async () => {
      try { await client.close() } catch { /* best-effort */ }
      try { await transport.close() } catch { /* best-effort */ }
    }
  }
}

export function runReconnectingProxy(config: ReconnectingProxyConfig): ReconnectingProxyController {
  let stopped = false
  let currentSeq: RegistrationSequenceResult | null = null

  async function waitForDisconnect(seq: RegistrationSequenceResult): Promise<void> {
    const interval = config.healthCheckIntervalMs ?? 200
    let disconnected = false
    const closeHandler = () => { disconnected = true }
    const prevOnClose = seq.transport.onclose
    seq.transport.onclose = () => { prevOnClose?.(); closeHandler() }
    while (!disconnected && !stopped) {
      await new Promise(r => setTimeout(r, interval))
      if (disconnected || stopped) break
      try {
        await seq.client.callTool({ name: 'echo', arguments: { msg: 'hb' } })
      } catch {
        disconnected = true
        break
      }
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        const seq = await runRegistrationSequence(config)
        currentSeq = seq
        if (config.onSequenceComplete) config.onSequenceComplete([...seq.order])

        await waitForDisconnect(seq)
        if (config.onDisconnect) config.onDisconnect()
        try { await seq.close() } catch { /* best-effort */ }
        currentSeq = null
      } catch {
        // register/bind/subscribe failed — wait and retry.
      }
      if (stopped) break
      const wait = config.backoffInitialMs ?? 500
      await new Promise(r => setTimeout(r, wait))
    }
  }

  void loop()

  return {
    stop: async () => {
      stopped = true
      if (currentSeq) {
        try { await currentSeq.close() } catch { /* best-effort */ }
      }
    }
  }
}
