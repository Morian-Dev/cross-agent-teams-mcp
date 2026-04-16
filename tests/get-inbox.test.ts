import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { SendMessageService } from '../src/mcp/send-message.js'
import { GetInboxService } from '../src/mcp/get-inbox.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('get_inbox', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  function setup(n: number) {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    agents.register({ agent_id: 'A', model: 'm', role: 'backend' })
    agents.register({ agent_id: 'B', model: 'm', role: 'frontend' })
    const send = new SendMessageService(db, agents, new EventsOutbox(db))
    for (let i = 0; i < n; i++) send.send({ from: 'A', to_agent_id: 'B', body: `msg-${i}` })
    return new GetInboxService(db, agents)
  }

  it('returns all messages with has_more=false when under limit', () => {
    const svc = setup(5)
    const r = svc.get({ caller: 'B', since_event_id: 0 })
    expect(r.messages.length).toBe(5)
    expect(r.has_more).toBe(false)
    expect(r.last_event_id).toBe(r.messages[r.messages.length - 1].event_id)
  })

  it('sets has_more=true when more rows exist beyond limit', () => {
    const svc = setup(120)
    const r = svc.get({ caller: 'B', since_event_id: 0, limit: 50 })
    expect(r.messages.length).toBe(50)
    expect(r.has_more).toBe(true)
  })

  it('applies since_event_id cursor', () => {
    const svc = setup(10)
    const first = svc.get({ caller: 'B', since_event_id: 0, limit: 3 })
    const cursor = first.last_event_id
    const next = svc.get({ caller: 'B', since_event_id: cursor, limit: 3 })
    expect(next.messages.length).toBe(3)
    expect(next.messages[0].event_id).toBeGreaterThan(cursor)
  })
})
