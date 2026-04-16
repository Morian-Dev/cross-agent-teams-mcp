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
import { PendingContractEventsService } from '../src/mcp/pending-contract-events.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('offline subscription catchup', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('subscriber polls after reconnect and receives missed events', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    agents.register({ agent_id: 'S', model: 'm', role: 'r' })
    agents.register({ agent_id: 'A', model: 'm', role: 'r' })
    new SubscribeContractService(db, agents).subscribe({ caller: 'S', name: 'X' })

    const currentCursor = 0
    const reg = new RegisterContractService(db, agents, new EventsOutbox(db))
    reg.register({ caller: 'A', name: 'X', schema: { type: 'object' } })
    reg.register({ caller: 'A', name: 'X', schema: { type: 'object', properties: { a: { type: 'string' } } } })
    reg.register({ caller: 'A', name: 'X', schema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } } })

    const poll = new PendingContractEventsService(db, agents)
    const r = poll.poll({ caller: 'S', since_event_id: currentCursor })
    expect(r.events.length).toBe(3)
    const versions = r.events.map(e => e.version).sort((a, b) => a - b)
    expect(versions).toEqual([1, 2, 3])
  })
})
