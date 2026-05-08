import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { insertAgent } from './helpers/insert-agent.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-cursor-mig-'))

function seedEvents(db: import('better-sqlite3').Database, count: number): number {
  const ts = new Date().toISOString()
  const stmt = db.prepare(
    `INSERT INTO events (from_team, to_team, event_type, actor_agent_id, payload, created_at) VALUES (?,?,?,?,?,?)`
  )
  for (let i = 0; i < count; i++) stmt.run('default', 'default', 'message_sent', null, '{}', ts)
  const max = db.prepare(`SELECT MAX(event_id) AS m FROM events`).get() as { m: number | null }
  return max.m ?? 0
}

function readCursor(db: import('better-sqlite3').Database, agentId: string): number {
  const row = db.prepare(`SELECT last_processed_event_id AS c FROM agents WHERE agent_id=?`).get(agentId) as { c: number }
  return row.c
}

describe('migrateAgentsCursorWatermark', () => {
  const dirs: string[] = []
  afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

  it('advances zero cursor to MAX(event_id)', () => {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    insertAgent(db, { agent_id: 'A' })
    expect(readCursor(db, 'A')).toBe(0)
    const max = seedEvents(db, 7)
    applySchema(db)
    expect(readCursor(db, 'A')).toBe(max)
  })

  it('leaves non-zero cursor untouched', () => {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    insertAgent(db, { agent_id: 'A' })
    seedEvents(db, 10)
    db.prepare(`UPDATE agents SET last_processed_event_id=? WHERE agent_id=?`).run(3, 'A')
    applySchema(db)
    expect(readCursor(db, 'A')).toBe(3)
  })

  it('leaves cursor at 0 when events table is empty', () => {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    insertAgent(db, { agent_id: 'A' })
    applySchema(db)
    expect(readCursor(db, 'A')).toBe(0)
  })

  it('is a no-op on the second run', () => {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    insertAgent(db, { agent_id: 'A' })
    const max = seedEvents(db, 5)
    applySchema(db)
    expect(readCursor(db, 'A')).toBe(max)
    // Add more events after the first migration; cursor must NOT bump on re-run
    seedEvents(db, 4)
    applySchema(db)
    expect(readCursor(db, 'A')).toBe(max)
  })
})
