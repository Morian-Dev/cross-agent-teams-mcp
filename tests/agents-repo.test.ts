import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('agents repo', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('register generates a fresh agent_id for a new identity', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const r = repo.register({ model: 'opus', role: 'backend', name: 'alice' })
    expect(typeof r.agent_id).toBe('string')
    expect(r.agent_id.length).toBeGreaterThan(0)
    expect(r.team).toBe('default')
    const row = db.prepare('SELECT * FROM agents WHERE agent_id=?').get(r.agent_id) as { role: string; team: string; name: string }
    expect(row.role).toBe('backend')
    expect(row.team).toBe('default')
    expect(row.name).toBe('alice')
    db.close()
  })

  it('repeated register for same identity reuses agent_id and upserts metadata', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const r1 = repo.register({ model: 'opus', role: 'backend', name: 'alice' })
    const r2 = repo.register({ model: 'sonnet', role: 'backend', name: 'alice' })
    expect(r2.agent_id).toBe(r1.agent_id)
    const row = db.prepare('SELECT * FROM agents WHERE agent_id=?').get(r1.agent_id) as { name: string; model: string }
    expect(row.name).toBe('alice')
    expect(row.model).toBe('sonnet')
    const count = db.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }
    expect(count.c).toBe(1)
    db.close()
  })

  it('list_agents returns only caller team', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const a1 = repo.register({ model: 'm', role: 'r', name: 'a1', team: 'alpha' })
    const a2 = repo.register({ model: 'm', role: 'r', name: 'a2', team: 'alpha' })
    repo.register({ model: 'm', role: 'r', name: 'b1', team: 'beta' })
    const out = repo.list({ team: 'alpha' })
    expect(out.map(a => a.agent_id).sort()).toEqual([a1.agent_id, a2.agent_id].sort())
  })

  it('online flag is true when last_seen_at within 5 minutes', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const fresh = repo.register({ model: 'm', role: 'r', name: 'fresh' })
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    db.prepare(`INSERT INTO agents (agent_id, team, role, name, registered_at, last_seen_at) VALUES (?,?,?,?,?,?)`)
      .run('stale', 'default', 'r', 'stale-name', stale, stale)
    const out = repo.list({ team: 'default' })
    const freshRow = out.find(a => a.agent_id === fresh.agent_id)!
    const staleRow = out.find(a => a.agent_id === 'stale')!
    expect(freshRow.online).toBe(true)
    expect(staleRow.online).toBe(false)
  })

  it('role change produces a new agent_id (new identity)', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const r1 = repo.register({ model: 'm', role: 'backend', name: 'alice' })
    const r2 = repo.register({ model: 'm', role: 'frontend', name: 'alice' })
    expect(r2.agent_id).not.toBe(r1.agent_id)
    const count = db.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }
    expect(count.c).toBe(2)
    db.close()
  })

  it('team change produces a new agent_id', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const r1 = repo.register({ model: 'm', role: 'backend', name: 'alice' })
    const r2 = repo.register({ model: 'm', role: 'backend', name: 'alice', team: 'alpha' })
    expect(r2.agent_id).not.toBe(r1.agent_id)
    const count = db.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }
    expect(count.c).toBe(2)
    db.close()
  })

  it('findByIdentity returns existing agent_id or undefined', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    expect(repo.findByIdentity({ team: 'default', name: 'alice', role: 'backend' })).toBeUndefined()
    const r = repo.register({ model: 'm', role: 'backend', name: 'alice' })
    expect(repo.findByIdentity({ team: 'default', name: 'alice', role: 'backend' })).toEqual({ agent_id: r.agent_id })
  })
})

describe('AgentsRepo tmux_pane_id', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  function freshRepo() {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    return { db, repo: new AgentsRepo(db) }
  }

  it('persists tmux_pane_id when provided', () => {
    const { db, repo } = freshRepo()
    const r = repo.register({ model: 'opus-4-7', role: 'frontend', name: 'alice', tmux_pane_id: '%42' })
    const row = db.prepare(`SELECT tmux_pane_id FROM agents WHERE agent_id=?`).get(r.agent_id) as { tmux_pane_id: string }
    expect(row.tmux_pane_id).toBe('%42')
    db.close()
  })

  it('stores NULL when tmux_pane_id is omitted', () => {
    const { db, repo } = freshRepo()
    const r = repo.register({ model: 'gpt-5', role: 'reviewer', name: 'bob' })
    const row = db.prepare(`SELECT tmux_pane_id FROM agents WHERE agent_id=?`).get(r.agent_id) as { tmux_pane_id: string | null }
    expect(row.tmux_pane_id).toBeNull()
    db.close()
  })

  it('upserts tmux_pane_id when same identity re-registers', () => {
    const { db, repo } = freshRepo()
    const r1 = repo.register({ model: 'opus-4-7', role: 'frontend', name: 'alice', tmux_pane_id: '%42' })
    const r2 = repo.register({ model: 'opus-4-7', role: 'frontend', name: 'alice', tmux_pane_id: '%99' })
    expect(r2.agent_id).toBe(r1.agent_id)
    const row = db.prepare(`SELECT tmux_pane_id FROM agents WHERE agent_id=?`).get(r1.agent_id) as { tmux_pane_id: string }
    expect(row.tmux_pane_id).toBe('%99')
    db.close()
  })

  it('preserves existing tmux_pane_id when re-register omits the field', () => {
    const { db, repo } = freshRepo()
    const r1 = repo.register({ model: 'opus-4-7', role: 'frontend', name: 'alice', tmux_pane_id: '%42' })
    repo.register({ model: 'opus-4-7', role: 'frontend', name: 'alice' })
    const row = db.prepare(`SELECT tmux_pane_id FROM agents WHERE agent_id=?`).get(r1.agent_id) as { tmux_pane_id: string }
    expect(row.tmux_pane_id).toBe('%42')
    db.close()
  })

  it('list returns tmux_pane_id for every agent (null when unset)', () => {
    const { db, repo } = freshRepo()
    const rA = repo.register({ model: 'opus-4-7', role: 'frontend', name: 'alice', tmux_pane_id: '%42' })
    const rB = repo.register({ model: 'gpt-5', role: 'reviewer', name: 'bob' })
    const rows = repo.list({ team: 'default' })
    const a = rows.find(r => r.agent_id === rA.agent_id)
    const b = rows.find(r => r.agent_id === rB.agent_id)
    expect(a?.tmux_pane_id).toBe('%42')
    expect(b?.tmux_pane_id).toBeNull()
    db.close()
  })

  it('stores non-tmux opaque strings verbatim', () => {
    const { db, repo } = freshRepo()
    const r = repo.register({ model: 'custom', role: 'exec', name: 'carol', tmux_pane_id: 'custom-pane-token-xyz' })
    const rows = repo.list({ team: 'default' })
    const c = rows.find(x => x.agent_id === r.agent_id)
    expect(c?.tmux_pane_id).toBe('custom-pane-token-xyz')
    db.close()
  })
})
