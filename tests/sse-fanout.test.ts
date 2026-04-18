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
import { SseFanout, type SseSink } from '../src/daemon/sse-fanout.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

function makeSink(): SseSink & { received: unknown[]; broken: boolean } {
  const received: unknown[] = []
  let broken = false
  return {
    received,
    get broken() { return broken },
    set broken(v) { broken = v },
    send(msg) {
      if (broken) throw new Error('broken')
      received.push(msg)
    },
    sendHeartbeat() {},
    close() {}
  }
}

describe('sse fanout', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('delivers contract_event only to subscribed sessions and survives broken sinks', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    agents.register({ agent_id: 'Sub', model: 'm', role: 'r' })
    agents.register({ agent_id: 'NoSub', model: 'm', role: 'r' })
    agents.register({ agent_id: 'Broken', model: 'm', role: 'r' })

    const fanout = new SseFanout()
    const sinkSub = makeSink()
    const sinkNo = makeSink()
    const sinkBroken = makeSink()
    sinkBroken.broken = true
    fanout.attach('Sub', 'default', sinkSub)
    fanout.attach('NoSub', 'default', sinkNo)
    fanout.attach('Broken', 'default', sinkBroken)

    new SubscribeContractService(db, agents).subscribe({ caller: 'Sub', name: 'X' })
    new SubscribeContractService(db, agents).subscribe({ caller: 'Broken', name: 'X' })

    const reg = new RegisterContractService(db, agents, new EventsOutbox(db))
    const result = reg.register({ caller: 'Sub', name: 'X', schema: { type: 'object' } })
    expect('version' in result).toBe(true)

    fanout.emitContractEvent(db, {
      team: 'default', contract_name: 'X',
      version: (result as { version: number }).version,
      event_id: (result as { version: number; diff?: unknown }).version,
      diff: null
    })

    expect(sinkSub.received.length).toBe(1)
    expect(sinkNo.received.length).toBe(0)
    expect(sinkBroken.received.length).toBe(0)
    const ev = db.prepare(`SELECT COUNT(*) as c FROM events WHERE event_type='contract_registered'`).get() as { c: number }
    expect(ev.c).toBe(1)
  })
})
