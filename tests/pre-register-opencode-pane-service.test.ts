import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { OpencodePanePreRegRepo } from '../src/storage/opencode-pane-prereg-repo.js'
import { PreRegisterOpencodePaneService } from '../src/mcp/pre-register-opencode-pane.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-opencode-pre-reg-svc-'))

describe('PreRegisterOpencodePaneService', () => {
  const cleanups: string[] = []
  let db: ReturnType<typeof openDb>
  let repo: OpencodePanePreRegRepo

  beforeEach(() => {
    const dir = tmp()
    cleanups.push(dir)
    db = openDb(join(dir, 'data.db'))
    applySchema(db)
    repo = new OpencodePanePreRegRepo(db)
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('persists with default 120s TTL and ISO expires_at', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z')
    const svc = new PreRegisterOpencodePaneService(repo, () => fixed)
    const res = svc.register({
      pane_id: '%10',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'ses_abc',
    })
    expect(res).toEqual({ ok: true, expires_at: '2026-01-01T00:02:00.000Z' })
    const rows = repo.listUnexpired('2026-01-01T00:00:00.000Z')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      pane_id: '%10',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'ses_abc',
    })
  })

  it('rejects missing pane_id', () => {
    const svc = new PreRegisterOpencodePaneService(repo)
    const res = svc.register({
      base_url: 'http://127.0.0.1:4096',
      session_id: 'ses_abc',
    })
    expect(res).toMatchObject({ error: 'invalid_arguments' })
    expect((res as { detail: string }).detail).toMatch(/pane_id/i)
  })

  it('rejects blank session_id', () => {
    const svc = new PreRegisterOpencodePaneService(repo)
    const res = svc.register({
      pane_id: '%10',
      base_url: 'http://127.0.0.1:4096',
      session_id: '   ',
    })
    // zod min(1) passes for whitespace; our trim then rejects.
    expect((res as { error?: string }).error).toBe('invalid_opencode_session_id')
  })

  it('rejects non-loopback base_url', () => {
    const svc = new PreRegisterOpencodePaneService(repo)
    const res = svc.register({
      pane_id: '%10',
      base_url: 'http://10.0.0.5:4096',
      session_id: 'ses_abc',
    })
    expect(res).toMatchObject({ error: 'invalid_opencode_base_url' })
  })

  it('clamps ttl_seconds above 600 to 600', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z')
    const svc = new PreRegisterOpencodePaneService(repo, () => fixed)
    const res = svc.register({
      pane_id: '%11',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'ses_x',
      ttl_seconds: 9999,
    })
    expect(res).toEqual({ ok: true, expires_at: '2026-01-01T00:10:00.000Z' })
  })

  it('overwrites existing row for same pane_id', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z')
    const svc = new PreRegisterOpencodePaneService(repo, () => fixed)
    svc.register({
      pane_id: '%12',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'A',
    })
    svc.register({
      pane_id: '%12',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'B',
    })
    const rows = repo.listUnexpired('2026-01-01T00:00:00.000Z')
    expect(rows).toHaveLength(1)
    expect(rows[0].session_id).toBe('B')
  })

  it('purges expired rows on write', () => {
    let t = new Date('2026-01-01T00:00:00.000Z').getTime()
    const svc = new PreRegisterOpencodePaneService(repo, () => new Date(t))
    svc.register({
      pane_id: '%OLD',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'O',
      ttl_seconds: 1,
    })
    t += 5_000
    svc.register({
      pane_id: '%NEW',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'N',
    })
    const rows = repo.listUnexpired(new Date(t).toISOString())
    expect(rows.map(r => r.pane_id).sort()).toEqual(['%NEW'])
  })

  it('rejects zero or negative ttl_seconds', () => {
    const svc = new PreRegisterOpencodePaneService(repo)
    const res = svc.register({
      pane_id: '%10',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'ses_x',
      ttl_seconds: 0,
    })
    expect(res).toMatchObject({ error: 'invalid_arguments' })
  })
})
