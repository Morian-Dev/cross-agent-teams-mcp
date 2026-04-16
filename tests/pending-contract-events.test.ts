import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { RegisterContractService } from '../src/mcp/register-contract.js'
import { PendingContractEventsService } from '../src/mcp/pending-contract-events.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('pending_contract_events', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  function setup(n: number) {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    agents.register({ agent_id: 'A', model: 'm', role: 'r' })
    const reg = new RegisterContractService(db, agents, new EventsOutbox(db))
    for (let i = 0; i < n; i++) {
      reg.register({ caller: 'A', name: 'X', schema: { type: 'object', properties: { n: { const: i } } } })
    }
    return new PendingContractEventsService(db, agents)
  }

  it('returns unseen events after cursor', () => {
    const svc = setup(3)
    const r = svc.poll({ caller: 'A', since_event_id: 1 })
    expect(r.events.length).toBeGreaterThanOrEqual(2)
    expect(r.last_event_id).toBeGreaterThan(1)
  })

  it('empty poll result when caught up', () => {
    const svc = setup(3)
    const r1 = svc.poll({ caller: 'A', since_event_id: 0 })
    const r2 = svc.poll({ caller: 'A', since_event_id: r1.last_event_id })
    expect(r2.events).toEqual([])
    expect(r2.last_event_id).toBe(r1.last_event_id)
  })
})
