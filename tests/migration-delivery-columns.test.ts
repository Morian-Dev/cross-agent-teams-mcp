import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-mig-'))

function createOldSchemaAgents(db: Database.Database): void {
  db.exec(`CREATE TABLE agents (
    agent_id TEXT PRIMARY KEY,
    team TEXT NOT NULL,
    role TEXT NOT NULL,
    name TEXT NOT NULL,
    model TEXT,
    registered_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_processed_event_id INTEGER NOT NULL DEFAULT 0,
    tmux_pane_id TEXT,
    channel_session_id TEXT
  )`)
  db.exec(`CREATE UNIQUE INDEX agents_identity_idx ON agents(team, name)`)
}

describe('migration: delivery columns', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('adds delivery_kind and delivery_payload to a pre-existing old-schema agents table', () => {
    const dir = tmp(); cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const db = openDb(dbPath)
    createOldSchemaAgents(db)

    const pre = db.pragma('table_info(agents)') as Array<{ name: string }>
    const preNames = pre.map(c => c.name)
    expect(preNames).not.toContain('delivery_kind')
    expect(preNames).not.toContain('delivery_payload')

    applySchema(db)

    const cols = db.pragma('table_info(agents)') as Array<{ name: string; type: string; notnull: number; dflt_value: string | null }>
    const deliveryKind = cols.find(c => c.name === 'delivery_kind')
    expect(deliveryKind).toBeDefined()
    expect(deliveryKind?.type).toBe('TEXT')
    expect(deliveryKind?.notnull).toBe(1)
    expect(deliveryKind?.dflt_value).toBe("'none'")
    const deliveryPayload = cols.find(c => c.name === 'delivery_payload')
    expect(deliveryPayload).toBeDefined()
    expect(deliveryPayload?.type).toBe('TEXT')
    expect(deliveryPayload?.notnull).toBe(0)
    db.close()
  })

  it('is idempotent: running applySchema twice does not error and leaves columns intact', () => {
    const dir = tmp(); cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const db = openDb(dbPath)
    createOldSchemaAgents(db)

    applySchema(db)
    const firstCols = (db.pragma('table_info(agents)') as Array<{ name: string }>).map(c => c.name).sort()

    expect(() => applySchema(db)).not.toThrow()

    const secondCols = (db.pragma('table_info(agents)') as Array<{ name: string }>).map(c => c.name).sort()
    expect(secondCols).toEqual(firstCols)
    expect(secondCols).toContain('delivery_kind')
    expect(secondCols).toContain('delivery_payload')
    db.close()
  })

  it('preserves existing row data when migrating (no data loss)', () => {
    const dir = tmp(); cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const db = openDb(dbPath)
    createOldSchemaAgents(db)
    db.prepare(`INSERT INTO agents (agent_id, team, role, name, registered_at, last_seen_at, channel_session_id)
      VALUES ('a1', 'teamA', 'dev', 'alice', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'csid-abc')`).run()

    applySchema(db)

    const row = db.prepare(`SELECT agent_id, team, name, channel_session_id FROM agents WHERE agent_id = ?`).get('a1') as { agent_id: string; team: string; name: string; channel_session_id: string | null }
    expect(row.agent_id).toBe('a1')
    expect(row.team).toBe('teamA')
    expect(row.name).toBe('alice')
    expect(row.channel_session_id).toBe('csid-abc')
    db.close()
  })
})
