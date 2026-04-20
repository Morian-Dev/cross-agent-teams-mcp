#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createProxyServer, relayChannelWake } from './proxy.js'
import { runReconnectingProxy } from './daemon-client.js'

interface CliArgs {
  daemonUrl: string
}

export class CliArgError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliArgError'
  }
}

export function buildStartupHint(csid: string): { content: string; meta: { source: string; kind: string } } {
  const content = [
    `ts-agent-teams: your channel_session_id is ${csid}.`,
    `If you have not called register_agent yet, call it first (the ts-agent-teams register_agent tool).`,
    `Then call bind_channel({channel_session_id: "${csid}"}) to complete binding.`,
    `If bind_channel returns unknown_agent, it means register_agent has not completed yet — call register_agent then retry bind_channel.`
  ].join(' ')
  return {
    content,
    meta: { source: 'ts_agent_teams', kind: 'startup_bind_hint' }
  }
}

export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  let daemonUrl: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = argv[i + 1]
    switch (flag) {
      case '--daemon-url':
        daemonUrl = next; i++; break
      default:
        // Ignore unknown flags for forward-compat (including legacy
        // --agent-team / --agent-name, which are no longer honored).
        break
    }
  }

  if (!daemonUrl || daemonUrl.length === 0) {
    daemonUrl = env.CROSS_AGENT_TEAMS_MCP_DAEMON_URL
  }

  if (!daemonUrl || daemonUrl.length === 0) {
    throw new CliArgError(
      'missing --daemon-url (or CROSS_AGENT_TEAMS_MCP_DAEMON_URL env var)'
    )
  }
  return { daemonUrl }
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  let args: CliArgs
  try {
    args = parseCliArgs(argv, env)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`ts-agent-teams-channel-proxy: ${msg}\n`)
    process.exit(2)
  }

  // Fresh csid per startup — no persistence. Multi-instance safe.
  const csid = randomUUID()

  const hostServer = createProxyServer()
  const stdioTransport = new StdioServerTransport()

  const controller = runReconnectingProxy({
    daemonUrl: args.daemonUrl,
    channel_session_id: csid,
    notificationHandler: (params) => {
      relayChannelWake(hostServer, params as { content: string; meta: Record<string, string> })
    },
    onSequenceComplete: () => {
      // Announce csid to Claude via host-facing channel notification so Claude
      // can call bind_channel({channel_session_id}) to bind its own agent row.
      const hint = buildStartupHint(csid)
      relayChannelWake(hostServer, hint)
    }
  })

  let stopped = false
  const shutdown = async (): Promise<void> => {
    if (stopped) return
    stopped = true
    try { await controller.stop() } catch { /* best-effort */ }
    try { await hostServer.close() } catch { /* best-effort */ }
    process.exit(0)
  }

  stdioTransport.onclose = () => { void shutdown() }

  await hostServer.connect(stdioTransport)

  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
}

// eslint-disable-next-line @typescript-eslint/no-misused-promises
if (import.meta.url === `file://${process.argv[1]}`) {
  void main()
}
