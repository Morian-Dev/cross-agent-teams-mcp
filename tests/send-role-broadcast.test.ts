import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { SendMessageService } from '../src/mcp/send-message.js'
import { BroadcastService } from '../src/mcp/broadcast.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('role fan-out and broadcast', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('to_role fan-out writes one message per recipient sharing event_id', async () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    agents.register({ agent_id: 'A', model: 'm', role: 'backend' })
    agents.register({ agent_id: 'F1', model: 'm', role: 'frontend' })
    agents.register({ agent_id: 'F2', model: 'm', role: 'frontend' })
    const svc = new SendMessageService(db, agents, new EventsOutbox(db))
    const r = await svc.send({ from: 'A', to_role: 'frontend', body: 'hi', auto_poke: false })
    if ('error' in r) throw new Error('expected success')
    expect([...r.recipients].sort()).toEqual(['F1','F2'])
    const rows = db.prepare('SELECT event_id FROM messages ORDER BY id').all() as Array<{ event_id: number }>
    expect(rows.length).toBe(2)
    expect(rows[0].event_id).toBe(rows[1].event_id)
  })

  it('broadcast excludes sender', async () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    agents.register({ agent_id: 'A', model: 'm', role: 'r' })
    agents.register({ agent_id: 'B', model: 'm', role: 'r' })
    agents.register({ agent_id: 'C', model: 'm', role: 'r' })
    const send = new SendMessageService(db, agents, new EventsOutbox(db))
    const svc = new BroadcastService(db, agents, send)
    const r = await svc.broadcast({ from: 'A', body: 'all' })
    if ('error' in r) throw new Error('expected success')
    expect([...r.recipients].sort()).toEqual(['B','C'])
  })
})
