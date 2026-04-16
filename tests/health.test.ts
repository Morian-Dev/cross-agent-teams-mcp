import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../src/daemon/server.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('health endpoint', () => {
  const cleanups: string[] = []
  afterEach(async () => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('returns ok, version, uptime_seconds without auth', async () => {
    const dir = tmp(); cleanups.push(dir)
    const app = await buildServer({ dbPath: join(dir, 'data.db'), token: 's3cret' })
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as { ok: boolean; version: string; uptime_seconds: number }
    expect(body.ok).toBe(true)
    expect(typeof body.version).toBe('string')
    expect(typeof body.uptime_seconds).toBe('number')
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(0)
    await app.close()
  })
})
