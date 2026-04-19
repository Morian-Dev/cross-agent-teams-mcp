import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo, ONLINE_MS } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { SendMessageService } from '../src/mcp/send-message.js'
import { BroadcastService } from '../src/mcp/broadcast.js'
import { insertAgent } from './helpers/insert-agent.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-fanout-offline-'))

function setLastSeen(db: ReturnType<typeof openDb>, agentId: string, iso: string): void {
  db.prepare('UPDATE agents SET last_seen_at=? WHERE agent_id=?').run(iso, agentId)
}

function offsetIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

describe('broadcast skips offline', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  function setup(): {
    db: ReturnType<typeof openDb>
    agents: AgentsRepo
    send: SendMessageService
    bcast: BroadcastService
  } {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    const send = new SendMessageService(db, agents, new EventsOutbox(db))
    const bcast = new BroadcastService(db, agents, send)
    return { db, agents, send, bcast }
  }

  it('excludes agents with last_seen_at older than ONLINE_MS', async () => {
    const { db, agents, bcast } = setup()
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'backend' , name: 'A' })
    insertAgent(db, { agent_id: 'B', model: 'm', role: 'backend' , name: 'B' })
    insertAgent(db, { agent_id: 'C', model: 'm', role: 'backend' , name: 'C' })
    insertAgent(db, { agent_id: 'D', model: 'm', role: 'backend' , name: 'D' })
    // C is offline (10 min ago > 5 min threshold)
    setLastSeen(db, 'C', offsetIso(10 * 60 * 1000))
    // D is online (30s ago)
    setLastSeen(db, 'D', offsetIso(30 * 1000))

    const r = await bcast.broadcast({ from: 'A', body: 'x', auto_poke: false })
    if ('error' in r) throw new Error('expected success')
    expect([...r.recipients].sort()).toEqual(['B', 'D'])

    const cRows = db.prepare('SELECT id FROM messages WHERE to_agent_id=?').all('C') as unknown[]
    expect(cRows.length).toBe(0)

    const ev = db.prepare('SELECT payload FROM events WHERE event_id=?').get(r.event_id) as
      { payload: string }
    const payload = JSON.parse(ev.payload) as { recipients: string[] }
    expect([...payload.recipients].sort()).toEqual(['B', 'D'])
  })

  it('returns unknown_recipient when all non-sender agents are offline', async () => {
    const { db, agents, bcast } = setup()
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'backend' , name: 'A' })
    insertAgent(db, { agent_id: 'B', model: 'm', role: 'backend' , name: 'B' })
    setLastSeen(db, 'B', offsetIso(6 * 60 * 1000))

    const eventsBefore = (db.prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }).c
    const msgsBefore = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c

    const r = await bcast.broadcast({ from: 'A', body: 'x', auto_poke: false })
    expect(r).toEqual({ error: 'unknown_recipient' })

    const eventsAfter = (db.prepare('SELECT COUNT(*) as c FROM events').get() as { c: number }).c
    const msgsAfter = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number }).c
    expect(eventsAfter).toBe(eventsBefore)
    expect(msgsAfter).toBe(msgsBefore)
  })

  it('list_agents still shows offline ghosts', () => {
    const { db, agents } = setup()
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'backend' , name: 'A' })
    insertAgent(db, { agent_id: 'B', model: 'm', role: 'backend' , name: 'B' })
    setLastSeen(db, 'B', offsetIso(10 * 60 * 1000))

    const list = agents.list({ team: 'default' })
    const ids = list.map(r => r.agent_id).sort()
    expect(ids).toEqual(['A', 'B'])
    const a = list.find(r => r.agent_id === 'A')!
    const b = list.find(r => r.agent_id === 'B')!
    expect(a.online).toBe(true)
    expect(b.online).toBe(false)
  })
})

describe('send_message to_role skips offline; to_agent_id does not', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  function setup(): {
    db: ReturnType<typeof openDb>
    agents: AgentsRepo
    send: SendMessageService
  } {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    const send = new SendMessageService(db, agents, new EventsOutbox(db))
    return { db, agents, send }
  }

  it('to_role with mixed online/offline yields only online recipients', async () => {
    const { db, agents, send } = setup()
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'backend' , name: 'A' })
    insertAgent(db, { agent_id: 'F1', model: 'm', role: 'frontend' , name: 'F1' })
    insertAgent(db, { agent_id: 'F2', model: 'm', role: 'frontend' , name: 'F2' })
    insertAgent(db, { agent_id: 'F3', model: 'm', role: 'frontend' , name: 'F3' })
    setLastSeen(db, 'F2', offsetIso(8 * 60 * 1000))

    const r = await send.send({ from: 'A', to_role: 'frontend', body: 'hi', auto_poke: false })
    if ('error' in r) throw new Error('expected success')
    expect([...r.recipients].sort()).toEqual(['F1', 'F3'])
    const f2Rows = db.prepare('SELECT id FROM messages WHERE to_agent_id=?').all('F2') as unknown[]
    expect(f2Rows.length).toBe(0)
  })

  it('to_role with all-offline matches returns unknown_recipient', async () => {
    const { db, agents, send } = setup()
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'backend' , name: 'A' })
    insertAgent(db, { agent_id: 'F1', model: 'm', role: 'frontend' , name: 'F1' })
    setLastSeen(db, 'F1', offsetIso(6 * 60 * 1000))

    const r = await send.send({ from: 'A', to_role: 'frontend', body: 'hi', auto_poke: false })
    expect(r).toEqual({ error: 'unknown_recipient' })
  })

  it('to_agent_id ignores online state (offline target still gets mailbox row)', async () => {
    const { db, agents, send } = setup()
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'backend' , name: 'A' })
    insertAgent(db, { agent_id: 'B', model: 'm', role: 'frontend' , name: 'B' })
    setLastSeen(db, 'B', offsetIso(3 * 60 * 60 * 1000)) // 3 hours ago

    const r = await send.send({ from: 'A', to_agent_id: 'B', body: 'hi', auto_poke: false })
    if ('error' in r) throw new Error('expected success for offline direct target')
    expect(r.recipients).toEqual(['B'])
    expect(r.message_id).toBeTruthy()
    expect(r.event_id).toBeGreaterThan(0)

    const msg = db.prepare('SELECT event_id, to_agent_id, body FROM messages WHERE id=?').get(r.message_id) as
      { event_id: number; to_agent_id: string; body: string }
    expect(msg.event_id).toBe(r.event_id)
    expect(msg.to_agent_id).toBe('B')
    expect(msg.body).toBe('hi')

    const ev = db.prepare('SELECT event_id, event_type FROM events WHERE event_id=?').get(r.event_id) as
      { event_id: number; event_type: string }
    expect(ev.event_type).toBe('message_sent')
  })
})

describe('ONLINE_MS sanity', () => {
  it('threshold is 5 minutes', () => {
    expect(ONLINE_MS).toBe(5 * 60 * 1000)
  })
})
