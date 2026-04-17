#!/usr/bin/env node
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './daemon/server.js'
import { wireShutdown } from './daemon/shutdown.js'
import { acquirePidFile } from './daemon/pid.js'
import { selectPort } from './daemon/port.js'

function parseArg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  if (cmd !== 'daemon') { console.error('usage: ts-agent-teams daemon [options]'); process.exit(2) }
  const home = process.env.TS_AGENT_TEAMS_HOME ?? join(homedir(), '.ts-agent-teams')
  const pidPath = parseArg('--pid-file', join(home, 'daemon.pid'))!
  const dbPath = parseArg('--db', join(home, 'data.db'))!
  const token = parseArg('--token')
  const requested = Number(parseArg('--port', '9100'))
  const port = requested === 0 ? 0 : await selectPort([requested, requested + 1, requested + 2])
  const r = acquirePidFile(pidPath, port || requested)
  if (!r.ok) { console.error('daemon already running pid=' + r.pid); process.exit(1) }
  const started = await startServer({ dbPath, token, port })
  wireShutdown(started.app, pidPath)
  console.log(`listening on ${started.host}:${started.port}`)
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1) })

export {}
