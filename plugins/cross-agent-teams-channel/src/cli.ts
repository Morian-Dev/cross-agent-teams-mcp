#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
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
    `cross-agent-teams-mcp: your channel_session_id is ${csid}.`,
    `Preferred in Claude Code: call register_agent({agent_type: "claude-code", name: "<agent-name>", ui_pid: $PPID}) from this session — do NOT pass channel_session_id here; the daemon auto-binds via ui_pid.`,
    `bind_channel({channel_session_id: "${csid}"}) is the low-level rebind tool for an already-registered Claude host that needs to switch to a fresh csid; it is NOT the primary registration path.`,
    `Do not use curl or another external HTTP client for Claude registration here — that would create a different MCP session, and follow-up tools in Claude Code could still see unknown_agent.`
  ].join(' ')
  return {
    content,
    meta: { source: 'cross_agent_teams_mcp', kind: 'startup_bind_hint' }
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
    process.stderr.write(`cross-agent-teams-proxy: ${msg}\n`)
    process.exit(2)
  }

  // Fresh csid per startup — no persistence. Multi-instance safe.
  const csid = randomUUID()

  const hostServer = createProxyServer()
  const stdioTransport = new StdioServerTransport()

  let registrationEverSucceeded = false
  const controller = runReconnectingProxy({
    daemonUrl: args.daemonUrl,
    channel_session_id: csid,
    notificationHandler: (params) => {
      relayChannelWake(hostServer, params as { content: string; meta: Record<string, string> })
    },
    onSequenceComplete: () => {
      registrationEverSucceeded = true
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
    if (!registrationEverSucceeded) {
      process.stderr.write(`cross-agent-teams-proxy: daemon unreachable at ${args.daemonUrl}\n`)
      process.exit(1)
    }
    process.exit(0)
  }

  stdioTransport.onclose = () => { void shutdown() }

  await hostServer.connect(stdioTransport)

  process.on('SIGTERM', () => { void shutdown() })
  process.on('SIGINT', () => { void shutdown() })
}

// Entry-point check.  The naive `import.meta.url === \`file://${process.argv[1]}\``
// breaks when launched via an npm `.bin` symlink (npx, `npm install -g`):
// process.argv[1] is the symlink path, while import.meta.url is already
// resolved.  Compare realpath-resolved file paths instead.
function isEntry(): boolean {
  try {
    const metaPath = fileURLToPath(import.meta.url)
    const argvPath = realpathSync(process.argv[1])
    return metaPath === argvPath
  } catch {
    return false
  }
}

// eslint-disable-next-line @typescript-eslint/no-misused-promises
if (isEntry()) {
  void main()
}
