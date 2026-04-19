import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { RegisterContractService } from '../src/mcp/register-contract.js'
import { GetContractService } from '../src/mcp/get-contract.js'
import { DiffContractsService } from '../src/mcp/diff-contracts.js'
import { insertAgent } from './helpers/insert-agent.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('get_contract and diff_contracts', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  function setup() {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'r' , name: 'A' })
    const reg = new RegisterContractService(db, agents, new EventsOutbox(db))
    return { db, agents, reg,
      get: new GetContractService(db, agents),
      diff: new DiffContractsService(db, agents)
    }
  }

  it('get_contract returns latest when version omitted', () => {
    const { reg, get } = setup()
    reg.register({ caller: 'A', name: 'X', schema: { type: 'object' } })
    reg.register({ caller: 'A', name: 'X', schema: { type: 'object', properties: { a: { type: 'string' } } } })
    reg.register({ caller: 'A', name: 'X', schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } } })
    const r = get.get({ caller: 'A', name: 'X' })
    if ('error' in r) throw new Error('unexpected error')
    expect(r.version).toBe(3)
  })

  it('unknown contract returns unknown_contract', () => {
    const { get } = setup()
    const r = get.get({ caller: 'A', name: 'no-such' })
    expect(r).toEqual({ error: 'unknown_contract' })
  })

  it('diff_contracts returns the expected diff between two versions', () => {
    const { reg, diff } = setup()
    reg.register({ caller: 'A', name: 'X', schema: { type: 'object', properties: { a: { type: 'string' } } } })
    reg.register({ caller: 'A', name: 'X', schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } } })
    const d = diff.diff({ caller: 'A', name: 'X', from_version: 1, to_version: 2 })
    if ('error' in d) throw new Error('unexpected error')
    expect(d.added_fields.map(f => f.path)).toContain('/properties/b')
  })
})
