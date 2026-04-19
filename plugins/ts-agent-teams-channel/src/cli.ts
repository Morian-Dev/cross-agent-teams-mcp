#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createProxyServer, relayChannelWake } from './proxy.js'
import { runReconnectingProxy } from './daemon-client.js'
import { resolveCsid, resolveCacheDir } from './csid-store.js'

interface CliArgs {
  daemonUrl: string
  team: string
  name: string
}

export class CliArgError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliArgError'
  }
}

export function parseCliArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): CliArgs {
  let daemonUrl: string | undefined
  let team: string | undefined
  let name: string | undefined

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = argv[i + 1]
    switch (flag) {
      case '--daemon-url':
        daemonUrl = next; i++; break
      case '--agent-team':
        team = next; i++; break
      case '--agent-name':
        name = next; i++; break
      default:
        // Ignore unknown flags for forward-compat.
        break
    }
  }

  if (!daemonUrl || daemonUrl.length === 0) {
    daemonUrl = env.TS_AGENT_TEAMS_DAEMON_URL
  }

  if (!daemonUrl || daemonUrl.length === 0) {
    throw new CliArgError(
      'missing --daemon-url (or TS_AGENT_TEAMS_DAEMON_URL env var)'
    )
  }
  if (!team || team.length === 0) {
    throw new CliArgError('missing --agent-team')
  }
  if (!name || name.length === 0) {
    throw new CliArgError('missing --agent-name')
  }
  return { daemonUrl, team, name }
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

  const cacheDir = resolveCacheDir(env)
  const csid = resolveCsid({ cacheDir, team: args.team, name: args.name })

  const hostServer = createProxyServer()
  const stdioTransport = new StdioServerTransport()

  const controller = runReconnectingProxy({
    daemonUrl: args.daemonUrl,
    team: args.team,
    name: args.name,
    channel_session_id: csid,
    notificationHandler: (params) => {
      relayChannelWake(hostServer, params as { content: string; meta: Record<string, string> })
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
