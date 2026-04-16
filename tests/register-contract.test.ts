import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { RegisterContractService } from '../src/mcp/register-contract.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('register_contract', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  function setup() {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    agents.register({ agent_id: 'A', model: 'm', role: 'r' })
    return { db, svc: new RegisterContractService(db, agents, new EventsOutbox(db)) }
  }

  it('first registration is version 1 with no diff', () => {
    const { svc } = setup()
    const r = svc.register({ caller: 'A', name: 'X', schema: { type: 'object' } }) as {
      name: string; version: number; diff?: unknown
    }
    expect(r.name).toBe('X')
    expect(r.version).toBe(1)
    expect(r.diff).toBeUndefined()
  })

  it('sequential registrations increment version and event row appended', () => {
    const { db, svc } = setup()
    svc.register({ caller: 'A', name: 'X', schema: { type: 'object', properties: { a: { type: 'string' } } } })
    const r = svc.register({ caller: 'A', name: 'X', schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } } })
    expect((r as { version: number }).version).toBe(2)
    const ev = db.prepare(`SELECT event_type FROM events WHERE event_type='contract_registered'`).all() as Array<{ event_type: string }>
    expect(ev.length).toBe(2)
  })

  it('version 2 response carries diff.added_fields', () => {
    const { svc } = setup()
    svc.register({ caller: 'A', name: 'X', schema: { type: 'object', properties: { a: { type: 'string' } } } })
    const r = svc.register({ caller: 'A', name: 'X', schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } } }) as
      { version: number; diff: { added_fields: Array<{ path: string }> } }
    expect(r.diff.added_fields.map(f => f.path)).toContain('/properties/b')
  })
})
