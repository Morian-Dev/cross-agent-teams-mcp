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

  it('register uses session id as agent_id and returns { agent_id, team }', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    const r = repo.register({ agent_id: 'sess-A', model: 'opus', role: 'backend' })
    expect(r).toEqual({ agent_id: 'sess-A', team: 'default' })
    const row = db.prepare('SELECT * FROM agents WHERE agent_id=?').get('sess-A') as { role: string; team: string }
    expect(row.role).toBe('backend')
    expect(row.team).toBe('default')
    db.close()
  })

  it('repeated register upserts metadata', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    repo.register({ agent_id: 'sess-A', model: 'opus', role: 'backend' })
    repo.register({ agent_id: 'sess-A', model: 'opus', role: 'backend', display_name: 'alice' })
    const row = db.prepare('SELECT * FROM agents WHERE agent_id=?').get('sess-A') as { display_name: string }
    expect(row.display_name).toBe('alice')
    db.close()
  })

  it('list_agents returns only caller team', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    repo.register({ agent_id: 'a1', model: 'm', role: 'r', team: 'alpha' })
    repo.register({ agent_id: 'a2', model: 'm', role: 'r', team: 'alpha' })
    repo.register({ agent_id: 'b1', model: 'm', role: 'r', team: 'beta' })
    const out = repo.list({ team: 'alpha' })
    expect(out.map(a => a.agent_id).sort()).toEqual(['a1','a2'])
  })

  it('online flag is true when last_seen_at within 5 minutes', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const repo = new AgentsRepo(db)
    repo.register({ agent_id: 'fresh', model: 'm', role: 'r' })
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    db.prepare(`INSERT INTO agents (agent_id, team, role, registered_at, last_seen_at) VALUES (?,?,?,?,?)`)
      .run('stale', 'default', 'r', stale, stale)
    const out = repo.list({ team: 'default' })
    const fresh = out.find(a => a.agent_id === 'fresh')!
    const staleRow = out.find(a => a.agent_id === 'stale')!
    expect(fresh.online).toBe(true)
    expect(staleRow.online).toBe(false)
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
    repo.register({ agent_id: 'sess-A', model: 'opus-4-7', role: 'frontend', tmux_pane_id: '%42' })
    const row = db.prepare(`SELECT tmux_pane_id FROM agents WHERE agent_id='sess-A'`).get() as { tmux_pane_id: string }
    expect(row.tmux_pane_id).toBe('%42')
    db.close()
  })

  it('stores NULL when tmux_pane_id is omitted', () => {
    const { db, repo } = freshRepo()
    repo.register({ agent_id: 'sess-B', model: 'gpt-5', role: 'reviewer' })
    const row = db.prepare(`SELECT tmux_pane_id FROM agents WHERE agent_id='sess-B'`).get() as { tmux_pane_id: string | null }
    expect(row.tmux_pane_id).toBeNull()
    db.close()
  })

  it('upserts tmux_pane_id when the same session re-registers', () => {
    const { db, repo } = freshRepo()
    repo.register({ agent_id: 'sess-A', model: 'opus-4-7', role: 'frontend', tmux_pane_id: '%42' })
    repo.register({ agent_id: 'sess-A', model: 'opus-4-7', role: 'frontend', tmux_pane_id: '%99' })
    const row = db.prepare(`SELECT tmux_pane_id FROM agents WHERE agent_id='sess-A'`).get() as { tmux_pane_id: string }
    expect(row.tmux_pane_id).toBe('%99')
    db.close()
  })

  it('preserves existing tmux_pane_id when re-register omits the field', () => {
    const { db, repo } = freshRepo()
    repo.register({ agent_id: 'sess-A', model: 'opus-4-7', role: 'frontend', tmux_pane_id: '%42' })
    repo.register({ agent_id: 'sess-A', model: 'opus-4-7', role: 'frontend' })
    const row = db.prepare(`SELECT tmux_pane_id FROM agents WHERE agent_id='sess-A'`).get() as { tmux_pane_id: string }
    expect(row.tmux_pane_id).toBe('%42')
    db.close()
  })
})
