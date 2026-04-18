import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/daemon/server.js'
import { scheduleRetry, __peekRetryMap, clearAllRetries } from '../src/mcp/poke-retry.js'

describe('daemon shutdown clears pending poke-retry timers', () => {
  const cleanups: string[] = []
  afterEach(() => {
    clearAllRetries()
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('app.close() invokes onClose hook which clears retry map', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atm-shutdown-retry-'))
    cleanups.push(dir)
    const { app } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })

    scheduleRetry({
      agentId: 'B',
      messageId: 'm-shutdown-1',
      fromAgentId: 'A',
      body: 'hi',
      team: 'default',
      sentAt: '2020-01-01T00:00:00.000Z',
      paneId: '%2',
      paneGuardFn: async () => 'fail',
      pokeFn: async () => { /* noop */ },
      lookupAgentFn: () => ({ agent_id: 'B', tmux_pane_id: '%2', last_seen_at: '2019-12-31T00:00:00.000Z' })
    })
    expect(__peekRetryMap().size).toBeGreaterThanOrEqual(1)

    await app.close()

    expect(__peekRetryMap().size).toBe(0)
  })
})
