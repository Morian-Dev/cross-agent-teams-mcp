import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/daemon/server.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { runRegistrationSequence } from '../plugins/ts-agent-teams-channel/src/daemon-client.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-proxy-retry-'))

describe('proxy bind_channel retry with backoff', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('retries bind_channel with exponential backoff until owner registers, then proceeds', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = `http://${host}:${port}/mcp`

    // Run proxy registration concurrently — owner is NOT yet registered.
    const startedAt = Date.now()
    const seqPromise = runRegistrationSequence({
      daemonUrl: url,
      team: 'default',
      name: 'alice',
      channel_session_id: 'csid-abc',
      backoffInitialMs: 20,
      backoffMaxMs: 200
    })

    // After a short delay, register the owner so bind_channel starts succeeding.
    await new Promise(r => setTimeout(r, 150))
    const ownerT = new StreamableHTTPClientTransport(new URL(url))
    const ownerC = new Client({ name: 'owner', version: '0.0.0' })
    await ownerC.connect(ownerT)
    await ownerC.callTool({
      name: 'register_agent',
      arguments: { model: 'opus', role: 'backend', name: 'alice' }
    })

    const seq = await seqPromise
    const elapsed = Date.now() - startedAt
    expect(seq.order).toEqual(['register_agent', 'bind_channel', 'subscribe_channel_wake'])
    expect(seq.lastBindResult).toEqual({ ok: true })
    // sanity: sequence took longer than the owner-registration delay
    expect(elapsed).toBeGreaterThanOrEqual(150)
    // Proxy retried bind_channel at least twice (first attempt fails with
    // agent_not_registered, later attempts succeed after owner registers).
    expect(seq.bindAttempts).toBeGreaterThanOrEqual(2)

    await seq.close()
    await ownerC.close()
    await app.close()
  }, 30000)
})
