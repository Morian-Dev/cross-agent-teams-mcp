import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { SendMessageService, type AutoPokeFn, type AutoPokeSkipReason } from '../src/mcp/send-message.js'
import { BroadcastService } from '../src/mcp/broadcast.js'
import { __setCapturePaneTail, __resetCapturePaneTail } from '../src/mcp/poke-guard.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-bcast-autopoke-'))

interface PokeCall { target: string; pane: string }

function setupService(opts?: { paneState?: Record<string, 'idle' | 'active'> }): {
  svc: BroadcastService
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
    return `active-${paneId}-${Math.random()}`
  })

  const pokeCalls: PokeCall[] = []
  const fakePoke: AutoPokeFn = async ({ targetAgentId, paneId }) => {
    pokeCalls.push({ target: targetAgentId, pane: paneId })
    return { ok: true }
  }

  const send = new SendMessageService(db, agents, events, { poke: fakePoke })
  const svc = new BroadcastService(db, agents, send, { poke: fakePoke })
  return { svc, db, pokeCalls, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('broadcast auto_poke opt-in integration', () => {
  const cleanups: Array<() => void> = []
  beforeEach(() => { process.env.POKE_QUIET_MS = '100' })
  afterEach(() => {
    cleanups.forEach(c => c()); cleanups.length = 0
    __resetCapturePaneTail()
    delete process.env.POKE_QUIET_MS
  })

  it('default broadcast (auto_poke omitted) does not poke anyone, no skip_reasons, retry_scheduled:false', async () => {
    const { svc, db, pokeCalls, cleanup } = setupService()
    cleanups.push(cleanup)
    const agents = new AgentsRepo(db)
    agents.register({ agent_id: 'A', model: 'm', role: 'lead', tmux_pane_id: '%1' })
    agents.register({ agent_id: 'B', model: 'm', role: 'worker', tmux_pane_id: '%2' })
    agents.register({ agent_id: 'C', model: 'm', role: 'worker', tmux_pane_id: '%3' })
    agents.register({ agent_id: 'D', model: 'm', role: 'worker', tmux_pane_id: '%4' })

    const r = await svc.broadcast({ from: 'A', body: 'status update' })
    if ('error' in r) throw new Error('expected success')

    expect(r.recipients.sort()).toEqual(['B', 'C', 'D'])
    expect(r.poked).toBe(false)
    expect(r.poke_skip_reasons).toBeUndefined()
    expect(pokeCalls.length).toBe(0)
    expect(r.retry_scheduled).toBe(false)
    expect(r.retry_delays_s).toBeUndefined()
  })

  it('explicit auto_poke:true with mixed panes: pokes idle ones, skip_reasons lists only no_pane/guard_failed', async () => {
    const { svc, db, pokeCalls, cleanup } = setupService({
      paneState: { '%2': 'idle', '%3': 'idle' }
    })
    cleanups.push(cleanup)
    const agents = new AgentsRepo(db)
    agents.register({ agent_id: 'A', model: 'm', role: 'lead', tmux_pane_id: '%1' })
    agents.register({ agent_id: 'B', model: 'm', role: 'worker', tmux_pane_id: '%2' })
    agents.register({ agent_id: 'C', model: 'm', role: 'worker', tmux_pane_id: '%3' })
    agents.register({ agent_id: 'D', model: 'm', role: 'worker' }) // no pane

    const r = await svc.broadcast({ from: 'A', body: 'urgent', auto_poke: true })
    if ('error' in r) throw new Error('expected success')

    expect(r.recipients.sort()).toEqual(['B', 'C', 'D'])
    expect(r.poked).toBe(true)
    expect(pokeCalls.map(c => c.target).sort()).toEqual(['B', 'C'])
    const reasons = r.poke_skip_reasons ?? []
    expect(reasons).toContainEqual({ agent_id: 'D', reason: 'no_pane' as AutoPokeSkipReason })
    expect(reasons.some(x => x.reason === 'guard_failed')).toBe(false)
    // No guard_failed → no retry
    expect(r.retry_scheduled).toBe(false)
    expect(r.retry_delays_s).toBeUndefined()
  })

  it('explicit auto_poke:true with active pane: guard_failed → retry_scheduled:true, delays=[30,180,600]', async () => {
    const { svc, db, pokeCalls, cleanup } = setupService({
      paneState: { '%2': 'active' }
    })
    cleanups.push(cleanup)
    const agents = new AgentsRepo(db)
    agents.register({ agent_id: 'A', model: 'm', role: 'lead', tmux_pane_id: '%1' })
    agents.register({ agent_id: 'B', model: 'm', role: 'worker', tmux_pane_id: '%2' })

    const r = await svc.broadcast({ from: 'A', body: 'urgent', auto_poke: true })
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
})
