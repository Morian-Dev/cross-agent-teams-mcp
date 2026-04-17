import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('agents schema', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('creates agents table with required columns', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const cols = db.pragma('table_info(agents)') as Array<{ name: string; type: string; notnull: number }>
    const names = cols.map(c => c.name).sort()
    expect(names).toEqual([
      'agent_id','display_name','last_processed_event_id','last_seen_at','model','registered_at','role','team','tmux_pane_id'
    ])
    const pk = cols.find(c => c.name === 'agent_id') as { pk: number } | undefined
    expect(pk?.pk).toBe(1)
    const pane = cols.find(c => c.name === 'tmux_pane_id') as { notnull: number; type: string } | undefined
    expect(pane?.type).toBe('TEXT')
    expect(pane?.notnull).toBe(0)
    db.close()
  })
})
