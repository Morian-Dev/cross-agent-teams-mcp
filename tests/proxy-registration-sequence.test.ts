import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../src/daemon/server.js'
import { runRegistrationSequence } from '../plugins/ts-agent-teams-channel/src/daemon-client.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-proxy-reg-'))

describe('proxy registration sequence (self-binding)', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('runs register_agent → subscribe_channel_wake (no bind_channel)', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = `http://${host}:${port}/mcp`

    const seq = await runRegistrationSequence({
      daemonUrl: url,
      channel_session_id: 'csid-abc',
      backoffInitialMs: 10,
      backoffMaxMs: 50
    })
    expect(seq.order).toEqual(['register_agent', 'subscribe_channel_wake'])
    expect(seq.lastSubscribeResult).toEqual({ ok: true })

    await seq.close()
    await app.close()
  }, 20000)
})
