import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { CodexPanePreRegRepo } from '../src/mcp/codex-pane-pre-register-repo.js'
import { PreRegisterCodexPaneService } from '../src/mcp/pre-register-codex-pane.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-pre-reg-'))

describe('PreRegisterCodexPaneService', () => {
  const cleanups: string[] = []
  let dbPath: string
  let db: ReturnType<typeof openDb>
  let repo: CodexPanePreRegRepo

  beforeEach(() => {
    const dir = tmp()
    cleanups.push(dir)
    dbPath = join(dir, 'data.db')
    db = openDb(dbPath)
    applySchema(db)
    repo = new CodexPanePreRegRepo(db)
  })

  afterEach(() => {
    try { db.close() } catch { /* ignore */ }
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('persists a pre-reg with default 120s TTL', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z')
    const svc = new PreRegisterCodexPaneService(repo, () => fixed)
    const res = svc.register({ pane_id: '%10', xats_agent_id: 'U1' })
    expect(res).toEqual({ ok: true, expires_at: '2026-01-01T00:02:00.000Z' })
    const rows = repo.listUnexpired('2026-01-01T00:00:00.000Z')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ pane_id: '%10', xats_agent_id: 'U1' })
  })

  it('clamps ttl_seconds above 600 to 600', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z')
    const svc = new PreRegisterCodexPaneService(repo, () => fixed)
    const res = svc.register({ pane_id: '%11', xats_agent_id: 'U2', ttl_seconds: 9999 })
    expect(res).toEqual({ ok: true, expires_at: '2026-01-01T00:10:00.000Z' })
  })

  it('rejects missing pane_id', () => {
    const svc = new PreRegisterCodexPaneService(repo)
    const res = svc.register({ xats_agent_id: 'U1' })
    expect(res).toMatchObject({ error: 'invalid_arguments' })
    expect((res as { detail: string }).detail).toMatch(/pane_id/i)
    expect(repo.listUnexpired(new Date().toISOString())).toHaveLength(0)
  })

  it('rejects empty xats_agent_id', () => {
    const svc = new PreRegisterCodexPaneService(repo)
    const res = svc.register({ pane_id: '%10', xats_agent_id: '' })
    expect(res).toMatchObject({ error: 'invalid_arguments' })
    expect((res as { detail: string }).detail).toMatch(/xats_agent_id/i)
  })

  it('rejects pane_id not starting with %', () => {
    const svc = new PreRegisterCodexPaneService(repo)
    const res = svc.register({ pane_id: '1972', xats_agent_id: 'U1' })
    expect(res).toMatchObject({ error: 'invalid_arguments' })
    expect((res as { detail: string }).detail).toMatch(/pane_id/i)
  })

  it('rejects non-positive ttl_seconds', () => {
    const svc = new PreRegisterCodexPaneService(repo)
    const res = svc.register({ pane_id: '%10', xats_agent_id: 'U1', ttl_seconds: 0 })
    expect(res).toMatchObject({ error: 'invalid_arguments' })
  })

  it('overwrites existing pre-reg for same pane', () => {
    const fixed = new Date('2026-01-01T00:00:00.000Z')
    const svc = new PreRegisterCodexPaneService(repo, () => fixed)
    svc.register({ pane_id: '%10', xats_agent_id: 'A' })
    svc.register({ pane_id: '%10', xats_agent_id: 'B' })
    const rows = repo.listUnexpired('2026-01-01T00:00:00.000Z')
    expect(rows).toHaveLength(1)
    expect(rows[0].xats_agent_id).toBe('B')
  })

  it('deleteExpired runs on write and removes stale rows', () => {
    let t = new Date('2026-01-01T00:00:00.000Z').getTime()
    const svc = new PreRegisterCodexPaneService(repo, () => new Date(t))
    svc.register({ pane_id: '%OLD', xats_agent_id: 'X', ttl_seconds: 1 })
    // jump forward past expiry
    t += 5_000
    svc.register({ pane_id: '%NEW', xats_agent_id: 'Y' })
    const rows = repo.listUnexpired(new Date(t).toISOString())
    expect(rows.map(r => r.pane_id).sort()).toEqual(['%NEW'])
  })
})
