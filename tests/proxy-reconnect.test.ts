import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/daemon/server.js'
import { runReconnectingProxy } from '../plugins/cross-agent-teams-channel/src/daemon-client.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-proxy-reconn-'))

describe('proxy reconnect on daemon disconnect', () => {
  const cleanups: string[] = []
  afterEach(() => {
    vi.restoreAllMocks()
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('re-executes register_agent → subscribe_channel_wake after daemon restart', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app: app1, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = `http://${host}:${port}/mcp`

    const history: string[][] = []
    const controller = runReconnectingProxy({
      daemonUrl: url,
      channel_session_id: 'csid-abc',
      backoffInitialMs: 20,
      backoffMaxMs: 200,
      healthCheckIntervalMs: 100,
      onSequenceComplete: (order) => { history.push(order) }
    })

    // Wait for first sequence to complete.
    const firstDeadline = Date.now() + 5000
    while (history.length < 1 && Date.now() < firstDeadline) {
      await new Promise(r => setTimeout(r, 50))
    }
    expect(history).toHaveLength(1)
    expect(history[0]).toEqual(['register_agent', 'subscribe_channel_wake'])

    // Simulate daemon restart by closing the app and starting a new one on the same port+db.
    await app1.close()

    const { app: app2 } = await startServer({ dbPath: join(dir, 'data.db'), port, host })

    // Wait for the proxy to reconnect and redo the sequence.
    const deadline = Date.now() + 4000
    while (history.length < 2 && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
    }
    expect(history.length).toBeGreaterThanOrEqual(2)
    expect(history[1]).toEqual(['register_agent', 'subscribe_channel_wake'])

    await controller.stop()
    await app2.close()
  }, 30000)

  it('backs off failed registration attempts exponentially up to the cap', async () => {
    const calls: number[] = []
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      calls.push(Date.now())
      throw new Error('connect failed')
    })
    const controller = runReconnectingProxy({
      daemonUrl: 'http://127.0.0.1:9/mcp',
      channel_session_id: 'csid-backoff',
      backoffInitialMs: 20,
      backoffMaxMs: 80,
      healthCheckIntervalMs: 100,
    })

    try {
      const deadline = Date.now() + 1000
      while (calls.length < 4 && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5))
      }
    } finally {
      await controller.stop()
      fetchMock.mockRestore()
    }

    expect(calls.length).toBeGreaterThanOrEqual(4)
    const deltas = calls.slice(1, 4).map((ts, idx) => ts - calls[idx])
    expect(deltas[0]).toBeGreaterThanOrEqual(15)
    expect(deltas[1]).toBeGreaterThanOrEqual(30)
    expect(deltas[2]).toBeGreaterThanOrEqual(60)
  }, 5000)
})
