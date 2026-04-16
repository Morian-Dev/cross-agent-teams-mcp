import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { TaskAddService } from '../src/mcp/task-add.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('task_add', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('creates tasks table with status CHECK', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const cols = db.pragma('table_info(tasks)') as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('status')
    expect(() => db.prepare(`INSERT INTO tasks (id, team, title, status, depends_on, created_at) VALUES ('t','default','x','bogus','[]','now')`).run())
      .toThrow(/CHECK/i)
  })

  it('task_add inserts pending and emits event', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    agents.register({ agent_id: 'A', model: 'm', role: 'r' })
    const svc = new TaskAddService(db, agents, new EventsOutbox(db))
    const r = svc.add({ caller: 'A', title: 'write docs' })
    if ('error' in r) throw new Error('expected success')
    expect(r.task_id).toMatch(/[a-f0-9-]{10,}/)
    const row = db.prepare('SELECT status, depends_on FROM tasks WHERE id=?').get(r.task_id) as
      { status: string; depends_on: string }
    expect(row.status).toBe('pending')
    expect(row.depends_on).toBe('[]')
    const ev = db.prepare('SELECT event_type FROM events ORDER BY event_id DESC LIMIT 1').get() as { event_type: string }
    expect(ev.event_type).toBe('task_added')
  })
})
