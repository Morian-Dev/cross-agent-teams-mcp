import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

function freshRepo() {
  const dir = tmp()
  const db = openDb(join(dir, 'data.db'))
  applySchema(db)
  return { dir, db, repo: new AgentsRepo(db) }
}

describe('AgentsRepo channel_session_id', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('create-path persists channel_session_id when provided', () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const r = repo.register({
      model: 'opus', role: 'backend', name: 'alice',
      channel_session_id: 'csid-abc'
    })
    const row = db.prepare(`SELECT channel_session_id FROM agents WHERE agent_id=?`).get(r.agent_id) as
      { channel_session_id: string | null }
    expect(row.channel_session_id).toBe('csid-abc')
    db.close()
  })

  it('create-path stores NULL when channel_session_id omitted or blank', () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const r1 = repo.register({ model: 'opus', role: 'backend', name: 'alice' })
    const row1 = db.prepare(`SELECT channel_session_id FROM agents WHERE agent_id=?`).get(r1.agent_id) as
      { channel_session_id: string | null }
    expect(row1.channel_session_id).toBeNull()

    const r2 = repo.register({
      model: 'opus', role: 'backend', name: 'bob',
      channel_session_id: '   '
    })
    const row2 = db.prepare(`SELECT channel_session_id FROM agents WHERE agent_id=?`).get(r2.agent_id) as
      { channel_session_id: string | null }
    expect(row2.channel_session_id).toBeNull()
    db.close()
  })

  it('reuse-path preserves prior channel_session_id when omitted', () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const r1 = repo.register({
      model: 'opus', role: 'backend', name: 'alice',
      channel_session_id: 'csid-abc'
    })
    // Re-register without csid
    repo.register({ model: 'sonnet', role: 'backend', name: 'alice' })
    const row = db.prepare(`SELECT channel_session_id FROM agents WHERE agent_id=?`).get(r1.agent_id) as
      { channel_session_id: string | null }
    expect(row.channel_session_id).toBe('csid-abc')
    db.close()
  })

  it('reuse-path preserves prior channel_session_id when blank provided', () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const r1 = repo.register({
      model: 'opus', role: 'backend', name: 'alice',
      channel_session_id: 'csid-abc'
    })
    repo.register({
      model: 'sonnet', role: 'backend', name: 'alice',
      channel_session_id: '   '
    })
    const row = db.prepare(`SELECT channel_session_id FROM agents WHERE agent_id=?`).get(r1.agent_id) as
      { channel_session_id: string | null }
    expect(row.channel_session_id).toBe('csid-abc')
    db.close()
  })

  it('reuse-path overwrites channel_session_id when new non-blank provided', () => {
    const { dir, db, repo } = freshRepo(); cleanups.push(dir)
    const r1 = repo.register({
      model: 'opus', role: 'backend', name: 'alice',
      channel_session_id: 'csid-old'
    })
    repo.register({
      model: 'opus', role: 'backend', name: 'alice',
      channel_session_id: 'csid-new'
    })
    const row = db.prepare(`SELECT channel_session_id FROM agents WHERE agent_id=?`).get(r1.agent_id) as
      { channel_session_id: string | null }
    expect(row.channel_session_id).toBe('csid-new')
    db.close()
  })
})
