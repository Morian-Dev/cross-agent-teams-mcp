import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { RegisterContractService } from '../src/mcp/register-contract.js'
import { runCleanup } from '../src/daemon/cleanup.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

function seedEvents(db: import('better-sqlite3').Database, team: string, count: number, daysOld: number) {
  const ts = new Date(Date.now() - daysOld * 86400 * 1000).toISOString()
  const stmt = db.prepare(
    `INSERT INTO events (team, event_type, actor_agent_id, payload, created_at) VALUES (?,?,?,?,?)`
  )
  for (let i = 0; i < count; i++) stmt.run(team, 'message_sent', null, '{}', ts)
}

describe('events cleanup', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('keeps events >= min online cursor when agents are online', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    agents.register({ agent_id: 'A', model: 'm', role: 'r' })
    seedEvents(db, 'default', 100, 8)
    db.prepare('UPDATE agents SET last_processed_event_id=? WHERE agent_id=?').run(50, 'A')
    runCleanup(db, { maxAgeDays: 7, now: new Date() })
    const remaining = (db.prepare('SELECT COUNT(*) c FROM events').get() as { c: number }).c
    expect(remaining).toBe(51) // events 50..100 preserved
  })

  it('deletes all aged events when no agents online', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    agents.register({ agent_id: 'Stale', model: 'm', role: 'r' })
    const oldTs = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    db.prepare('UPDATE agents SET last_seen_at=? WHERE agent_id=?').run(oldTs, 'Stale')
    seedEvents(db, 'default', 100, 8)
    runCleanup(db, { maxAgeDays: 7, now: new Date(), onlineWindowMs: 5 * 60 * 1000 })
    const remaining = (db.prepare('SELECT COUNT(*) c FROM events').get() as { c: number }).c
    expect(remaining).toBe(0)
  })

  it('does not touch contracts/tasks/agents tables', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    agents.register({ agent_id: 'A', model: 'm', role: 'r' })
    const reg = new RegisterContractService(db, agents, new EventsOutbox(db))
    reg.register({ caller: 'A', name: 'X', schema: { type: 'object' } })
    db.prepare('UPDATE contracts SET registered_at=? WHERE name=?')
      .run(new Date(Date.now() - 30 * 86400 * 1000).toISOString(), 'X')
    runCleanup(db, { maxAgeDays: 7, now: new Date() })
    const c = (db.prepare('SELECT COUNT(*) c FROM contracts').get() as { c: number }).c
    expect(c).toBe(1)
  })
})
