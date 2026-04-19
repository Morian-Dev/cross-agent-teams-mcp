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

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-sm-byname-'))

describe('send_message by name — same-team resolution', () => {
  const dirs: string[] = []
  afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

  function setup() {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const svc = new SendMessageService(db, new AgentsRepo(db), new EventsOutbox(db))
    return { svc, db }
  }

  it('resolves to_agent_name to UUID and writes message row', async () => {
    const { svc, db } = setup()
    insertAgent(db, { agent_id: 'uuid-A', team: 'default', role: 'backend', name: 'alice' })
    insertAgent(db, { agent_id: 'uuid-B', team: 'default', role: 'frontend', name: 'bob' })
    const resp = await svc.send({ from: 'uuid-A', to_agent_name: 'bob', body: 'hi', auto_poke: false })
    if ('error' in resp) throw new Error(`expected success, got ${resp.error}`)
    expect(resp.recipients).toEqual(['uuid-B'])
    const m = db.prepare(`SELECT to_agent_id, body FROM messages WHERE id=?`).get(resp.message_id) as
      { to_agent_id: string; body: string }
    expect(m.to_agent_id).toBe('uuid-B')
    expect(m.body).toBe('hi')
  })

  it('returns missing_recipient when neither to_agent_id nor to_agent_name given', async () => {
    const { svc, db } = setup()
    insertAgent(db, { agent_id: 'uuid-A', team: 'default', role: 'backend', name: 'alice' })
    const resp = await svc.send({ from: 'uuid-A', body: 'hi', auto_poke: false } as unknown as Parameters<typeof svc.send>[0])
    expect(resp).toEqual({ error: 'missing_recipient' })
    const count = db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number }
    expect(count.c).toBe(0)
  })

  it('returns ambiguous_recipient when both to_agent_id and to_agent_name given', async () => {
    const { svc, db } = setup()
    insertAgent(db, { agent_id: 'uuid-A', team: 'default', role: 'backend', name: 'alice' })
    insertAgent(db, { agent_id: 'uuid-B', team: 'default', role: 'frontend', name: 'bob' })
    const resp = await svc.send({
      from: 'uuid-A', to_agent_id: 'uuid-B', to_agent_name: 'bob', body: 'hi', auto_poke: false
    })
    expect(resp).toEqual({ error: 'ambiguous_recipient' })
    const count = db.prepare(`SELECT COUNT(*) AS c FROM messages`).get() as { c: number }
    expect(count.c).toBe(0)
  })
})
