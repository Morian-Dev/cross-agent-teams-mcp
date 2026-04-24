#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './daemon/server.js'
import { wireShutdown } from './daemon/shutdown.js'
import { acquirePidFile } from './daemon/pid.js'
import { selectPort } from './daemon/port.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

function parseArg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def
}

function defaultHome(): string {
  return process.env.CROSS_AGENT_TEAMS_MCP_HOME ?? join(homedir(), '.cross-agent-teams-mcp')
}

async function runDaemon(): Promise<void> {
  const home = defaultHome()
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

function resolveDaemonPort(explicit: string | undefined): number | undefined {
  if (explicit !== undefined) {
    const n = Number(explicit)
    if (Number.isInteger(n) && n > 0) return n
    return undefined
  }
  const pidPath = parseArg('--pid-file', join(defaultHome(), 'daemon.pid'))!
  if (!existsSync(pidPath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(pidPath, 'utf8')) as { port?: number }
    if (typeof parsed.port === 'number' && parsed.port > 0) return parsed.port
  } catch { /* ignore corrupt pid file */ }
  return undefined
}

async function runPreRegisterCodexPane(): Promise<void> {
  const pane = parseArg('--pane')
  const agentId = parseArg('--agent-id')
  const ttlRaw = parseArg('--ttl')
  const tokenExplicit = parseArg('--token')
  const portExplicit = parseArg('--port')

  if (!pane || !agentId) {
    console.error('usage: cross-agent-teams-mcp pre-register-codex-pane --pane <pane_id> --agent-id <uuid> [--ttl <seconds>] [--port <n>] [--token <t>]')
    process.exit(2)
  }

  const port = resolveDaemonPort(portExplicit)
  if (!port) {
    console.error('{"ok":false,"error":"daemon_port_unresolved","detail":"pass --port or start the daemon so the pid file is present"}')
    process.exit(1)
  }

  const token = tokenExplicit ?? process.env.CROSS_AGENT_TEAMS_MCP_TOKEN
  const host = process.env.CROSS_AGENT_TEAMS_MCP_HOST ?? '127.0.0.1'
  const base = new URL(`http://${host}:${port}/mcp`)

  const requestInit: RequestInit | undefined = token
    ? { headers: { Authorization: `Bearer ${token}` } }
    : undefined

  const transport = new StreamableHTTPClientTransport(base, {
    requestInit,
  })
  const client = new Client({ name: 'cross-agent-teams-mcp-cli', version: '0.1.0' })

  try {
    await client.connect(transport)
    const args: Record<string, unknown> = {
      pane_id: pane,
      xats_agent_id: agentId,
    }
    if (ttlRaw !== undefined) {
      const ttl = Number(ttlRaw)
      if (!Number.isInteger(ttl) || ttl <= 0) {
        console.error('{"ok":false,"error":"invalid_ttl"}')
        process.exit(2)
      }
      args.ttl_seconds = ttl
    }
    const resp = await client.callTool({
      name: 'pre_register_codex_pane',
      arguments: args,
    })
    const content = (resp as { content?: Array<{ text?: string }> }).content
    const text = content?.[0]?.text ?? ''
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
    const obj = (parsed ?? {}) as Record<string, unknown>
    if (obj.ok === true) {
      console.log(JSON.stringify(obj))
      process.exit(0)
    }
    console.error(JSON.stringify(obj))
    process.exit(1)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(JSON.stringify({ ok: false, error: 'cli_failed', detail: msg }))
    process.exit(1)
  } finally {
    try { await transport.close() } catch { /* best-effort */ }
    try { await client.close() } catch { /* best-effort */ }
  }
}

async function runPreRegisterOpencodePane(): Promise<void> {
  const pane = parseArg('--pane')
  const baseUrl = parseArg('--base-url')
  const sessionId = parseArg('--session-id')
  const ttlRaw = parseArg('--ttl')
  const tokenExplicit = parseArg('--token')
  const portExplicit = parseArg('--port')

  if (!pane || !baseUrl || !sessionId) {
    console.error('usage: cross-agent-teams-mcp pre-register-opencode-pane --pane <pane_id> --base-url <url> --session-id <id> [--ttl <seconds>] [--port <n>] [--token <t>]')
    process.exit(2)
  }

  const port = resolveDaemonPort(portExplicit)
  if (!port) {
    console.error('{"ok":false,"error":"daemon_port_unresolved","detail":"pass --port or start the daemon so the pid file is present"}')
    process.exit(1)
  }

  const token = tokenExplicit ?? process.env.CROSS_AGENT_TEAMS_MCP_TOKEN
  const host = process.env.CROSS_AGENT_TEAMS_MCP_HOST ?? '127.0.0.1'
  const base = new URL(`http://${host}:${port}/mcp`)

  const requestInit: RequestInit | undefined = token
    ? { headers: { Authorization: `Bearer ${token}` } }
    : undefined

  const transport = new StreamableHTTPClientTransport(base, { requestInit })
  const client = new Client({ name: 'cross-agent-teams-mcp-cli', version: '0.1.0' })

  try {
    await client.connect(transport)
    const args: Record<string, unknown> = {
      pane_id: pane,
      base_url: baseUrl,
      session_id: sessionId,
    }
    if (ttlRaw !== undefined) {
      const ttl = Number(ttlRaw)
      if (!Number.isInteger(ttl) || ttl <= 0) {
        console.error('{"ok":false,"error":"invalid_ttl"}')
        process.exit(2)
      }
      args.ttl_seconds = ttl
    }
    const resp = await client.callTool({
      name: 'pre_register_opencode_pane',
      arguments: args,
    })
    const content = (resp as { content?: Array<{ text?: string }> }).content
    const text = content?.[0]?.text ?? ''
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
    const obj = (parsed ?? {}) as Record<string, unknown>
    if (obj.ok === true) {
      console.log(JSON.stringify(obj))
      process.exit(0)
    }
    console.error(JSON.stringify(obj))
    process.exit(1)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.error(JSON.stringify({ ok: false, error: 'cli_failed', detail: msg }))
    process.exit(1)
  } finally {
    try { await transport.close() } catch { /* best-effort */ }
    try { await client.close() } catch { /* best-effort */ }
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  if (cmd === 'daemon') {
    await runDaemon()
    return
  }
  if (cmd === 'pre-register-codex-pane') {
    await runPreRegisterCodexPane()
    return
  }
  if (cmd === 'pre-register-opencode-pane') {
    await runPreRegisterOpencodePane()
    return
  }
  console.error('usage: cross-agent-teams-mcp <daemon|pre-register-codex-pane|pre-register-opencode-pane> [options]')
  process.exit(2)
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(1) })

export {}
