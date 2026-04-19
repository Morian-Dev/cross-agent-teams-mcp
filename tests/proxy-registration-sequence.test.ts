import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/daemon/server.js'
import { runRegistrationSequence } from '../plugins/ts-agent-teams-channel/src/daemon-client.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-proxy-reg-'))

describe('proxy registration sequence', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('runs register_agent → bind_channel → subscribe_channel_wake when owner exists', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = `http://${host}:${port}/mcp`

    // First have the owner agent pre-register so bind_channel succeeds immediately.
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
    const ownerT = new StreamableHTTPClientTransport(new URL(url))
    const ownerC = new Client({ name: 'owner', version: '0.0.0' })
    await ownerC.connect(ownerT)
    await ownerC.callTool({
      name: 'register_agent',
      arguments: { model: 'opus', role: 'backend', name: 'alice' }
    })

    const seq = await runRegistrationSequence({
      daemonUrl: url,
      team: 'default',
      name: 'alice',
      channel_session_id: 'csid-abc',
      backoffInitialMs: 10,
      backoffMaxMs: 50
    })
    expect(seq.order).toEqual(['register_agent', 'bind_channel', 'subscribe_channel_wake'])
    expect(seq.lastBindResult).toEqual({ ok: true })
    expect(seq.lastSubscribeResult).toEqual({ ok: true })

    await seq.close()
    await ownerT.close()
    await ownerC.close()
    await app.close()
  }, 20000)
})
