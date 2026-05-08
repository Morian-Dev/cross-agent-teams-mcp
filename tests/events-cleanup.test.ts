import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { RegisterContractService } from '../src/mcp/register-contract.js'
import { runCleanup } from '../src/daemon/cleanup.js'
import { insertAgent } from './helpers/insert-agent.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-cleanup-'))

interface EventTriple { event_id: number; message_id: string }

function seedEventWithMessage(
  db: import('better-sqlite3').Database,
  args: { team?: string; daysOld: number; recipients: string[]; messageIdPrefix: string }
): EventTriple {
  const team = args.team ?? 'default'
  const ts = new Date(Date.now() - args.daysOld * 86400 * 1000).toISOString()
  db.prepare(
    `INSERT INTO events (from_team, to_team, event_type, actor_agent_id, payload, created_at) VALUES (?,?,?,?,?,?)`
  ).run(team, team, 'message_sent', null, '{}', ts)
  const event_id = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id
  const insertMsg = db.prepare(
    `INSERT INTO messages (id, event_id, from_team, to_team, from_agent_id, to_agent_id, to_role, subject, body, sent_at)
     VALUES (?, ?, ?, ?, 'sender', ?, null, null, 'b', ?)`
  )
  const insertStatus = db.prepare(
    `INSERT INTO message_delivery_status (message_id, agent_id, wake_status, retry_attempts, updated_at)
     VALUES (?, ?, 'delivered', 0, ?)`
  )
  let firstMid = ''
  args.recipients.forEach((r, i) => {
    const mid = `${args.messageIdPrefix}-${i}`
    if (i === 0) firstMid = mid
    insertMsg.run(mid, event_id, team, team, r, ts)
    insertStatus.run(mid, r, ts)
  })
  return { event_id, message_id: firstMid }
}

describe('runCleanup uniform 30-day TTL', () => {
  const dirs: string[] = []
  afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

  function fresh(): ReturnType<typeof openDb> {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    return db
  }

  function counts(db: ReturnType<typeof openDb>): { events: number; messages: number; status: number } {
    return {
      events: (db.prepare('SELECT COUNT(*) c FROM events').get() as { c: number }).c,
      messages: (db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c,
      status: (db.prepare('SELECT COUNT(*) c FROM message_delivery_status').get() as { c: number }).c,
    }
  }

  it('deletes 31-day-old rows in all three tables', () => {
    const db = fresh()
    insertAgent(db, { agent_id: 'B' })
    seedEventWithMessage(db, { daysOld: 31, recipients: ['B'], messageIdPrefix: 'm-old' })
    expect(counts(db)).toEqual({ events: 1, messages: 1, status: 1 })
    const res = runCleanup(db)
    expect(res.deleted).toBe(3)
    expect(counts(db)).toEqual({ events: 0, messages: 0, status: 0 })
  })

  it('keeps 29-day-old rows intact', () => {
    const db = fresh()
    insertAgent(db, { agent_id: 'B' })
    seedEventWithMessage(db, { daysOld: 29, recipients: ['B'], messageIdPrefix: 'm-young' })
    runCleanup(db)
    expect(counts(db)).toEqual({ events: 1, messages: 1, status: 1 })
  })

  it('broadcast (3 recipients sharing one event) deletes all 3 messages + 3 status rows + 1 event row', () => {
    const db = fresh()
    insertAgent(db, { agent_id: 'B' })
    insertAgent(db, { agent_id: 'C' })
    insertAgent(db, { agent_id: 'D' })
    seedEventWithMessage(db, { daysOld: 31, recipients: ['B', 'C', 'D'], messageIdPrefix: 'bcast' })
    expect(counts(db)).toEqual({ events: 1, messages: 3, status: 3 })
    const res = runCleanup(db)
    expect(res.deleted).toBe(7) // 3 status + 3 messages + 1 event
    expect(counts(db)).toEqual({ events: 0, messages: 0, status: 0 })
  })

  it('cursor position is irrelevant: old rows are deleted regardless of last_processed_event_id', () => {
    const db = fresh()
    insertAgent(db, { agent_id: 'B' })
    db.prepare(`UPDATE agents SET last_processed_event_id=0 WHERE agent_id=?`).run('B')
    seedEventWithMessage(db, { daysOld: 31, recipients: ['B'], messageIdPrefix: 'm' })
    runCleanup(db)
    expect(counts(db)).toEqual({ events: 0, messages: 0, status: 0 })
  })

  it('does not touch agents, tasks, contracts, contract_subscriptions', () => {
    const db = fresh()
    insertAgent(db, { agent_id: 'A' })
    const agents = new AgentsRepo(db)
    const reg = new RegisterContractService(db, agents, new EventsOutbox(db))
    reg.register({ caller: 'A', name: 'X', schema: { type: 'object' } })
    db.prepare('UPDATE contracts SET registered_at=? WHERE name=?')
      .run(new Date(Date.now() - 90 * 86400 * 1000).toISOString(), 'X')
    db.prepare(
      `INSERT INTO tasks (id, team, title, status, depends_on, created_at)
       VALUES ('t1','default','t','pending','[]',?)`
    ).run(new Date(Date.now() - 90 * 86400 * 1000).toISOString())
    db.prepare(
      `INSERT INTO contract_subscriptions (agent_id, team, contract_name, subscribed_at)
       VALUES ('A','default','X',?)`
    ).run(new Date(Date.now() - 90 * 86400 * 1000).toISOString())
    runCleanup(db)
    const c = (db.prepare('SELECT COUNT(*) c FROM contracts').get() as { c: number }).c
    const t = (db.prepare('SELECT COUNT(*) c FROM tasks').get() as { c: number }).c
    const a = (db.prepare('SELECT COUNT(*) c FROM agents').get() as { c: number }).c
    const s = (db.prepare('SELECT COUNT(*) c FROM contract_subscriptions').get() as { c: number }).c
    expect(c).toBe(1)
    expect(t).toBe(1)
    expect(a).toBe(1)
    expect(s).toBe(1)
  })

  it('honours child→parent ordering with foreign keys ON (no transient FK violation)', () => {
    const db = fresh()
    // FK is enabled by openDb already; assert it
    const fk = db.pragma('foreign_keys', { simple: true })
    expect(fk).toBe(1)
    insertAgent(db, { agent_id: 'B' })
    seedEventWithMessage(db, { daysOld: 31, recipients: ['B'], messageIdPrefix: 'fk' })
    expect(() => runCleanup(db)).not.toThrow()
    const c = (db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c
    expect(c).toBe(0)
  })

  it('respects maxAgeDays override (test parameter)', () => {
    const db = fresh()
    insertAgent(db, { agent_id: 'B' })
    seedEventWithMessage(db, { daysOld: 8, recipients: ['B'], messageIdPrefix: 'm' })
    // Default 30d retains it
    runCleanup(db)
    expect(counts(db).messages).toBe(1)
    // Override to 7d deletes it
    runCleanup(db, { maxAgeDays: 7 })
    expect(counts(db)).toEqual({ events: 0, messages: 0, status: 0 })
  })
})
