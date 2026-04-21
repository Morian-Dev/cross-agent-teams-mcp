import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { SendMessageService, type AutoPokeFn, type AutoPokeSkipReason } from '../src/mcp/send-message.js'
import { __setCapturePaneTail, __resetCapturePaneTail } from '../src/mcp/poke-guard.js'
import { insertAgent } from './helpers/insert-agent.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-sm-autopoke-'))

interface PokeCall { target: string; pane: string | null }

function setupService(opts?: { paneState?: Record<string, 'idle' | 'active'> }): {
  svc: SendMessageService
  db: ReturnType<typeof openDb>
  pokeCalls: PokeCall[]
  cleanup: () => void
} {
  const dir = tmp()
  const db = openDb(join(dir, 'data.db'))
  applySchema(db)
  const agents = new AgentsRepo(db)
  const events = new EventsOutbox(db)

  const panes = opts?.paneState ?? {}
  __setCapturePaneTail(async (paneId: string) => {
    const state = Object.entries(panes).find(([pid]) => pid === paneId)?.[1] ?? 'idle'
    if (state === 'idle') return `idle-${paneId}`
    // active: return distinct tail each call
    return `active-${paneId}-${Math.random()}`
  })

  const pokeCalls: PokeCall[] = []
  const fakePoke: AutoPokeFn = async ({ targetAgentId, paneId }) => {
    pokeCalls.push({ target: targetAgentId, pane: paneId })
    return { ok: true }
  }

  const svc = new SendMessageService(db, agents, events, { poke: fakePoke })
  return { svc, db, pokeCalls, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('send_message auto_poke integration', () => {
  const cleanups: Array<() => void> = []
  beforeEach(() => { process.env.POKE_QUIET_MS = '100' })
  afterEach(() => {
    cleanups.forEach(c => c()); cleanups.length = 0
    __resetCapturePaneTail()
    delete process.env.POKE_QUIET_MS
  })

  it('single recipient with idle pane: poked:true, no skip_reasons, retry_scheduled:false', async () => {
    const { svc, db, pokeCalls, cleanup } = setupService({ paneState: { '%2': 'idle' } })
    cleanups.push(cleanup)
    const agents = new AgentsRepo(db)
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'caller', tmux_pane_id: '%1' , name: 'A' })
    insertAgent(db, { agent_id: 'B', model: 'm', role: 'worker', tmux_pane_id: '%2' , name: 'B' })

    const r = await svc.send({ from: 'A', to_agent_id: 'B', body: 'hi' })
    if ('error' in r) throw new Error('expected success')

    expect(r.poked).toBe(true)
    expect(r.poke_skip_reasons ?? []).toEqual([])
    expect(pokeCalls.length).toBe(1)
    expect(pokeCalls[0].target).toBe('B')
    expect(r.retry_scheduled).toBe(false)
    expect(r.retry_delays_s).toBeUndefined()
  })

  it('recipient without tmux_pane_id: poked:false, reason no_pane, retry_scheduled:false', async () => {
    const { svc, db, pokeCalls, cleanup } = setupService()
    cleanups.push(cleanup)
    const agents = new AgentsRepo(db)
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'caller', tmux_pane_id: '%1' , name: 'A' })
    insertAgent(db, { agent_id: 'B', model: 'm', role: 'worker' , name: 'B' }) // no pane

    const r = await svc.send({ from: 'A', to_agent_id: 'B', body: 'hi' })
    if ('error' in r) throw new Error('expected success')

    expect(r.poked).toBe(false)
    const reasons = r.poke_skip_reasons ?? []
    expect(reasons).toContainEqual({ agent_id: 'B', reason: 'no_pane' as AutoPokeSkipReason })
    expect(pokeCalls.length).toBe(0)
    expect(r.retry_scheduled).toBe(false)
    expect(r.retry_delays_s).toBeUndefined()
  })

  it('auto_poke:false disables the behavior, no skip_reasons', async () => {
    const { svc, db, pokeCalls, cleanup } = setupService({ paneState: { '%2': 'idle' } })
    cleanups.push(cleanup)
    const agents = new AgentsRepo(db)
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'caller', tmux_pane_id: '%1' , name: 'A' })
    insertAgent(db, { agent_id: 'B', model: 'm', role: 'worker', tmux_pane_id: '%2' , name: 'B' })

    const r = await svc.send({ from: 'A', to_agent_id: 'B', body: 'hi', auto_poke: false })
    if ('error' in r) throw new Error('expected success')

    expect(r.poked).toBe(false)
    expect(r.poke_skip_reasons).toBeUndefined()
    expect(pokeCalls.length).toBe(0)
  })

  it('single recipient with active pane: poked:false, guard_failed, retry_scheduled:true, delays=[30,180,600]', async () => {
    const { svc, db, pokeCalls, cleanup } = setupService({ paneState: { '%2': 'active' } })
    cleanups.push(cleanup)
    const agents = new AgentsRepo(db)
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'caller', tmux_pane_id: '%1' , name: 'A' })
    insertAgent(db, { agent_id: 'B', model: 'm', role: 'worker', tmux_pane_id: '%2' , name: 'B' })

    const r = await svc.send({ from: 'A', to_agent_id: 'B', body: 'hi' })
    if ('error' in r) throw new Error('expected success')

    expect(r.poked).toBe(false)
    expect(pokeCalls.length).toBe(0)
    const reasons = r.poke_skip_reasons ?? []
    expect(reasons).toContainEqual({ agent_id: 'B', reason: 'guard_failed' as AutoPokeSkipReason })
    expect(r.retry_scheduled).toBe(true)
    expect(r.retry_delays_s).toEqual([30, 180, 600])
    const { clearAllRetries } = await import('../src/mcp/poke-retry.js')
    clearAllRetries()
  })

  it('pokeFn exception is caught and falls back to guard_failed (mailbox still persisted)', async () => {
    const dir = tmp(); cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db); const events = new EventsOutbox(db)
    __setCapturePaneTail(async () => 'idle-tail')

    const pokeCalls: PokeCall[] = []
    const throwingPoke: AutoPokeFn = async ({ targetAgentId, paneId }) => {
      pokeCalls.push({ target: targetAgentId, pane: paneId })
      throw new Error('simulated tmux spawn failure')
    }
    const svc = new SendMessageService(db, agents, events, { poke: throwingPoke })

    insertAgent(db, { agent_id: 'A', model: 'm', role: 'caller', tmux_pane_id: '%1' , name: 'A' })
    insertAgent(db, { agent_id: 'B', model: 'm', role: 'worker', tmux_pane_id: '%2' , name: 'B' })

    const r = await svc.send({ from: 'A', to_agent_id: 'B', body: 'hi' })
    if ('error' in r) throw new Error('expected success, not error')
    expect(r.poked).toBe(false)
    expect(r.poke_skip_reasons ?? []).toContainEqual({ agent_id: 'B', reason: 'guard_failed' as AutoPokeSkipReason })
    // message still persisted
    const row = db.prepare('SELECT count(*) as c FROM messages WHERE to_agent_id=?').get('B') as { c: number }
    expect(row.c).toBe(1)
  })

  it('self as sole recipient is marked self (defensive; to_agent_id of caller)', async () => {
    const { svc, db, pokeCalls, cleanup } = setupService({ paneState: { '%1': 'idle' } })
    cleanups.push(cleanup)
    const agents = new AgentsRepo(db)
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'caller', tmux_pane_id: '%1' , name: 'A' })

    const r = await svc.send({ from: 'A', to_agent_id: 'A', body: 'hi' })
    if ('error' in r) throw new Error('expected success')
    expect(r.poked).toBe(false)
    const reasons = r.poke_skip_reasons ?? []
    expect(reasons).toContainEqual({ agent_id: 'A', reason: 'self' as AutoPokeSkipReason })
    expect(pokeCalls.length).toBe(0)
  })
})
