import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { OpencodePanePreRegRepo } from '../src/storage/opencode-pane-prereg-repo.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-opencode-prereg-repo-'))

describe('OpencodePanePreRegRepo', () => {
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

  it('upserts on same pane_id replacing base_url/session_id/expires_at', () => {
    repo.put({
      pane_id: '%1',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'A',
      expires_at: '2100-01-01T00:00:00.000Z',
    })
    repo.put({
      pane_id: '%1',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'B',
      expires_at: '2100-01-01T00:05:00.000Z',
    })
    const rows = repo.listUnexpired('2026-01-01T00:00:00.000Z')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      pane_id: '%1',
      session_id: 'B',
      expires_at: '2100-01-01T00:05:00.000Z',
    })
  })

  it('get() skips expired rows', () => {
    repo.put({
      pane_id: '%2',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'X',
      expires_at: '2000-01-01T00:00:00.000Z',
    })
    const row = repo.get('%2', '2026-01-01T00:00:00.000Z')
    expect(row).toBeUndefined()
  })

  it('purgeExpired removes only past rows', () => {
    repo.put({
      pane_id: '%OLD',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'O',
      expires_at: '2000-01-01T00:00:00.000Z',
    })
    repo.put({
      pane_id: '%NEW',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'N',
      expires_at: '2100-01-01T00:00:00.000Z',
    })
    const changes = repo.purgeExpired('2026-01-01T00:00:00.000Z')
    expect(changes).toBe(1)
    const remaining = repo.listUnexpired('2026-01-01T00:00:00.000Z')
    expect(remaining.map(r => r.pane_id)).toEqual(['%NEW'])
  })

  it('consume returns the row and deletes it', () => {
    repo.put({
      pane_id: '%3',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'S',
      expires_at: '2100-01-01T00:00:00.000Z',
    })
    const consumed = repo.consume('%3', '2026-01-01T00:00:00.000Z')
    expect(consumed).toMatchObject({ pane_id: '%3', session_id: 'S' })
    const after = repo.get('%3', '2026-01-01T00:00:00.000Z')
    expect(after).toBeUndefined()
  })

  it('consume skips expired rows and leaves them in place for purge', () => {
    repo.put({
      pane_id: '%EXP',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'E',
      expires_at: '2000-01-01T00:00:00.000Z',
    })
    const consumed = repo.consume('%EXP', '2026-01-01T00:00:00.000Z')
    expect(consumed).toBeUndefined()
    // still present until purged
    const count = (db.prepare('SELECT COUNT(*) AS c FROM opencode_pane_pre_registrations').get() as { c: number }).c
    expect(count).toBe(1)
  })
})
