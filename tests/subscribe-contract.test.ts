import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { RegisterContractService } from '../src/mcp/register-contract.js'
import { SubscribeContractService } from '../src/mcp/subscribe-contract.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('subscribe_contract', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('creates contract_subscriptions table with composite PK', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const cols = db.pragma('table_info(contract_subscriptions)') as Array<{ name: string; pk: number }>
    const pks = cols.filter(c => c.pk > 0).map(c => c.name).sort()
    expect(pks).toEqual(['agent_id','contract_name','team'])
  })

  it('subscribe returns current_version=null when contract missing, then latest', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    agents.register({ agent_id: 'A', model: 'm', role: 'r' })
    const sub = new SubscribeContractService(db, agents)
    const r1 = sub.subscribe({ caller: 'A', name: 'X' })
    expect(r1).toEqual({ ok: true, current_version: null })

    const reg = new RegisterContractService(db, agents, new EventsOutbox(db))
    reg.register({ caller: 'A', name: 'X', schema: { type: 'object' } })
    reg.register({ caller: 'A', name: 'X', schema: { type: 'object', properties: { a: { type: 'string' } } } })
    const r2 = sub.subscribe({ caller: 'A', name: 'X' })
    expect(r2).toEqual({ ok: true, current_version: 2 })
  })

  it('subscription persists across db reopen', () => {
    const dir = tmp(); cleanups.push(dir)
    const path = join(dir, 'data.db')
    {
      const db = openDb(path); applySchema(db)
      const agents = new AgentsRepo(db)
      agents.register({ agent_id: 'A', model: 'm', role: 'r' })
      new SubscribeContractService(db, agents).subscribe({ caller: 'A', name: 'X' })
      db.close()
    }
    const db = openDb(path); applySchema(db)
    const row = db.prepare('SELECT agent_id FROM contract_subscriptions WHERE contract_name=?').get('X')
    expect(row).toBeTruthy()
    db.close()
  })
})
