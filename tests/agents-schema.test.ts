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
    const cols = db.pragma('table_info(agents)') as Array<{ name: string; type: string }>
    const names = cols.map(c => c.name).sort()
    expect(names).toEqual([
      'agent_id','display_name','last_processed_event_id','last_seen_at','model','registered_at','role','team'
    ])
    const pk = cols.find(c => c.name === 'agent_id') as { pk: number } | undefined
    expect(pk?.pk).toBe(1)
    db.close()
  })
})
