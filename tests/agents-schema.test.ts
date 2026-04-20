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

  it('creates agents table with required columns and name is NOT NULL', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const cols = db.pragma('table_info(agents)') as Array<{ name: string; type: string; notnull: number; pk: number }>
    const names = cols.map(c => c.name).sort()
    expect(names).toEqual([
      'agent_id','channel_session_id','delivery_kind','delivery_payload','last_processed_event_id','last_seen_at','model','name','registered_at','role','team','tmux_pane_id'
    ])
    const pk = cols.find(c => c.name === 'agent_id')
    expect(pk?.pk).toBe(1)
    const nameCol = cols.find(c => c.name === 'name')
    expect(nameCol?.type).toBe('TEXT')
    expect(nameCol?.notnull).toBe(1)
    const pane = cols.find(c => c.name === 'tmux_pane_id')
    expect(pane?.type).toBe('TEXT')
    expect(pane?.notnull).toBe(0)
    db.close()
  })

  it('creates agents table with delivery_kind and delivery_payload columns', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
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
    const channel = cols.find(c => c.name === 'channel_session_id')
    expect(channel).toBeDefined()
    db.close()
  })

  it('creates UNIQUE agents_identity_idx covering (team, name)', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const indexes = db.pragma('index_list(agents)') as Array<{ name: string; unique: number }>
    const target = indexes.find(i => i.name === 'agents_identity_idx')
    expect(target).toBeDefined()
    expect(target?.unique).toBe(1)
    const info = db.pragma(`index_info(agents_identity_idx)`) as Array<{ seqno: number; name: string }>
    const ordered = info.sort((a, b) => a.seqno - b.seqno).map(i => i.name)
    expect(ordered).toEqual(['team', 'name'])
    db.close()
  })
})
