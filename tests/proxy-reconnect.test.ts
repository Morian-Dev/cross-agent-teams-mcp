import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/daemon/server.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runReconnectingProxy } from '../plugins/ts-agent-teams-channel/src/daemon-client.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-proxy-reconn-'))

describe('proxy reconnect on daemon disconnect', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('re-executes register_agent → bind_channel → subscribe_channel_wake after daemon restart', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app: app1, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = `http://${host}:${port}/mcp`

    // Pre-register the owner.
    const ownerT = new StreamableHTTPClientTransport(new URL(url))
    const ownerC = new Client({ name: 'owner', version: '0.0.0' })
    await ownerC.connect(ownerT)
    await ownerC.callTool({
      name: 'register_agent',
      arguments: { model: 'opus', role: 'backend', name: 'alice' }
    })

    const history: string[][] = []
    const controller = runReconnectingProxy({
      daemonUrl: url,
      team: 'default',
      name: 'alice',
      channel_session_id: 'csid-abc',
      backoffInitialMs: 20,
      backoffMaxMs: 200,
      healthCheckIntervalMs: 100,
      onSequenceComplete: (order) => { history.push(order) }
    })

    // Wait for first sequence to complete.
    await new Promise(r => setTimeout(r, 500))
    expect(history).toHaveLength(1)
    expect(history[0]).toEqual(['register_agent', 'bind_channel', 'subscribe_channel_wake'])

    // Simulate daemon restart by closing the app and starting a new one on the same port+db.
    await ownerC.close()
    await app1.close()

    const { app: app2 } = await startServer({ dbPath: join(dir, 'data.db'), port, host })
    // Re-register owner on the new daemon.
    const ownerT2 = new StreamableHTTPClientTransport(new URL(url))
    const ownerC2 = new Client({ name: 'owner', version: '0.0.0' })
    await ownerC2.connect(ownerT2)
    await ownerC2.callTool({
      name: 'register_agent',
      arguments: { model: 'opus', role: 'backend', name: 'alice' }
    })

    // Wait for the proxy to reconnect and redo the sequence.
    const deadline = Date.now() + 4000
    while (history.length < 2 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
    }
    expect(history.length).toBeGreaterThanOrEqual(2)
    expect(history[1]).toEqual(['register_agent', 'bind_channel', 'subscribe_channel_wake'])

    await controller.stop()
    await ownerC2.close()
    await app2.close()
  }, 30000)
})
