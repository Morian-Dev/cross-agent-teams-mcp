import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('contracts schema', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('creates contracts table and unique(team,name,version)', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const cols = db.pragma('table_info(contracts)') as Array<{ name: string }>
    const names = cols.map(c => c.name).sort()
    expect(names).toEqual([
      'format','id','name','note','registered_at','registered_by','schema','team','version'
    ])
    const idx = db.pragma('index_list(contracts)') as Array<{ unique: number; name: string }>
    const uniq = idx.find(i => i.unique === 1)
    expect(uniq).toBeTruthy()
    db.close()
  })
})
