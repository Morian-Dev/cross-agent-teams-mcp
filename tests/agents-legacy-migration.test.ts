import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-legacy-'))

describe('agents legacy migration', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('adds tmux_pane_id column to a legacy agents table without it', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))

    db.exec(`CREATE TABLE agents (
      agent_id TEXT PRIMARY KEY,
      team TEXT NOT NULL,
      role TEXT NOT NULL,
      display_name TEXT,
      model TEXT,
      registered_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_processed_event_id INTEGER NOT NULL DEFAULT 0
    )`)
    db.prepare(`INSERT INTO agents (agent_id, team, role, registered_at, last_seen_at)
                VALUES (?,?,?,?,?)`).run('legacy-a','default','backend','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')

    applySchema(db)

    const cols = db.pragma('table_info(agents)') as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('tmux_pane_id')
    const row = db.prepare(`SELECT tmux_pane_id FROM agents WHERE agent_id='legacy-a'`).get() as { tmux_pane_id: string | null }
    expect(row.tmux_pane_id).toBeNull()

    expect(() => applySchema(db)).not.toThrow()
    db.close()
  })
})
