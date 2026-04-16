import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('messages schema', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('creates messages table with columns and FK to events', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const cols = db.pragma('table_info(messages)') as Array<{ name: string; notnull: number }>
    const names = cols.map(c => c.name).sort()
    expect(names).toEqual([
      'body','event_id','from_agent_id','id','sent_at','subject','team','to_agent_id','to_role'
    ])
    const fks = db.pragma('foreign_key_list(messages)') as Array<{ table: string; from: string }>
    expect(fks.find(f => f.table === 'events' && f.from === 'event_id')).toBeTruthy()
    db.close()
  })
})
