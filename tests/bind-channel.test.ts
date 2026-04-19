import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { BindChannelService } from '../src/mcp/bind-channel.js'
import { ChannelWakeFanout } from '../src/daemon/channel-wake-fanout.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

function setup() {
  const dir = tmp()
  const db = openDb(join(dir, 'data.db'))
  applySchema(db)
  const repo = new AgentsRepo(db)
  const fanout = new ChannelWakeFanout()
  const svc = new BindChannelService(db, fanout)
  return { dir, db, repo, fanout, svc }
}

describe('bind_channel service (self-binding)', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('updates caller channel_session_id when csid has live sink and caller is non-proxy', () => {
    const { dir, db, repo, fanout, svc } = setup(); cleanups.push(dir)
    const alice = repo.register({ model: 'opus', role: 'backend', name: 'alice' })
    fanout.attach('csid-abc', () => { /* sink */ }, 'proxy-session-1')
    const res = svc.bind({
      callerAgentId: alice.agent_id,
      channel_session_id: 'csid-abc'
    })
    expect(res).toEqual({ ok: true })
    const row = db.prepare(`SELECT channel_session_id FROM agents WHERE agent_id=?`).get(alice.agent_id) as
      { channel_session_id: string | null }
    expect(row.channel_session_id).toBe('csid-abc')
    db.close()
  })

  it('returns unknown_channel_session when no sink is attached for csid', () => {
    const { dir, db, repo, svc } = setup(); cleanups.push(dir)
    const alice = repo.register({ model: 'opus', role: 'backend', name: 'alice' })
    const res = svc.bind({
      callerAgentId: alice.agent_id,
      channel_session_id: 'csid-ghost'
    })
    expect(res).toEqual({ error: 'unknown_channel_session' })
    const row = db.prepare(`SELECT channel_session_id FROM agents WHERE agent_id=?`).get(alice.agent_id) as
      { channel_session_id: string | null }
    expect(row.channel_session_id).toBeNull()
    db.close()
  })

  it('rejects proxy caller with forbidden_role', () => {
    const { dir, db, repo, fanout, svc } = setup(); cleanups.push(dir)
    const proxy = repo.register({ model: 'proxy', role: '__channel_proxy__', name: 'p1' })
    fanout.attach('csid-abc', () => { /* sink */ }, 'proxy-session-1')
    const res = svc.bind({
      callerAgentId: proxy.agent_id,
      channel_session_id: 'csid-abc'
    })
    expect(res).toEqual({ error: 'forbidden_role' })
    db.close()
  })

  it('returns unknown_agent when caller is not registered', () => {
    const { dir, db, svc } = setup(); cleanups.push(dir)
    const res = svc.bind({
      callerAgentId: 'ghost',
      channel_session_id: 'csid-abc'
    })
    expect(res).toEqual({ error: 'unknown_agent' })
    db.close()
  })

  it('returns invalid_channel_session_id when csid is blank', () => {
    const { dir, db, repo, svc } = setup(); cleanups.push(dir)
    const alice = repo.register({ model: 'opus', role: 'backend', name: 'alice' })
    const res = svc.bind({
      callerAgentId: alice.agent_id,
      channel_session_id: '   '
    })
    expect(res).toEqual({ error: 'invalid_channel_session_id' })
    db.close()
  })
})
