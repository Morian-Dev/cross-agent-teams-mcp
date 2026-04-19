import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { SendMessageService } from '../src/mcp/send-message.js'
import { insertAgent } from './helpers/insert-agent.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('send_message direct', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  function setup() {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'backend' , name: 'A' })
    insertAgent(db, { agent_id: 'B', model: 'm', role: 'frontend' , name: 'B' })
    return { db, svc: new SendMessageService(db, agents, new EventsOutbox(db)) }
  }

  it('rejects when both to_agent_id and to_role are given', async () => {
    const { svc } = setup()
    const r = await svc.send({ from: 'A', to_agent_id: 'B', to_role: 'frontend', body: 'x' })
    expect(r).toEqual({ error: 'ambiguous_recipient' })
  })

  it('rejects when neither recipient is given', async () => {
    const { svc } = setup()
    const r = await svc.send({ from: 'A', body: 'x' })
    expect(r).toEqual({ error: 'missing_recipient' })
  })

  it('rejects when to_agent_id is unknown in caller team', async () => {
    const { svc } = setup()
    const r = await svc.send({ from: 'A', to_agent_id: 'Z', body: 'x' })
    expect(r).toEqual({ error: 'unknown_recipient' })
  })

  it('creates paired event and message rows on success', async () => {
    const { db, svc } = setup()
    const r = await svc.send({ from: 'A', to_agent_id: 'B', body: 'hi', auto_poke: false })
    if ('error' in r) throw new Error('expected success')
    expect(r.recipients).toEqual(['B'])
    expect(r.event_id).toBeGreaterThan(0)
    const ev = db.prepare('SELECT event_type, event_id FROM events WHERE event_id=?').get(r.event_id) as
      { event_type: string; event_id: number }
    expect(ev.event_type).toBe('message_sent')
    const msg = db.prepare('SELECT event_id, body FROM messages WHERE id=?').get(r.message_id) as
      { event_id: number; body: string }
    expect(msg.event_id).toBe(r.event_id)
    expect(msg.body).toBe('hi')
  })
})
