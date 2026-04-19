import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { BindChannelService } from '../src/mcp/bind-channel.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

function setup() {
  const dir = tmp()
  const db = openDb(join(dir, 'data.db'))
  applySchema(db)
  const repo = new AgentsRepo(db)
  const svc = new BindChannelService(db)
  return { dir, db, repo, svc }
}

describe('bind_channel service', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('updates channel_session_id when target row exists and caller is __channel_proxy__', () => {
    const { dir, db, repo, svc } = setup(); cleanups.push(dir)
    const alice = repo.register({ model: 'opus', role: 'backend', name: 'alice' })
    const proxy = repo.register({ model: 'proxy', role: '__channel_proxy__', name: 'p1' })
    const res = svc.bind({
      callerAgentId: proxy.agent_id,
      team: 'default',
      name: 'alice',
      channel_session_id: 'csid-abc'
    })
    expect(res).toEqual({ ok: true })
    const row = db.prepare(`SELECT channel_session_id FROM agents WHERE agent_id=?`).get(alice.agent_id) as
      { channel_session_id: string | null }
    expect(row.channel_session_id).toBe('csid-abc')
    db.close()
  })

  it('returns agent_not_registered when target row absent', () => {
    const { dir, db, repo, svc } = setup(); cleanups.push(dir)
    const proxy = repo.register({ model: 'proxy', role: '__channel_proxy__', name: 'p1' })
    const res = svc.bind({
      callerAgentId: proxy.agent_id,
      team: 'default',
      name: 'ghost',
      channel_session_id: 'csid-x'
    })
    expect(res).toEqual({ error: 'agent_not_registered' })
    db.close()
  })

  it('rejects non-proxy caller with forbidden_role and does not modify row', () => {
    const { dir, db, repo, svc } = setup(); cleanups.push(dir)
    const alice = repo.register({ model: 'opus', role: 'backend', name: 'alice' })
    const bob = repo.register({ model: 'opus', role: 'backend', name: 'bob' })
    const res = svc.bind({
      callerAgentId: bob.agent_id,
      team: 'default',
      name: 'alice',
      channel_session_id: 'csid-abc'
    })
    expect(res).toEqual({ error: 'forbidden_role' })
    const row = db.prepare(`SELECT channel_session_id FROM agents WHERE agent_id=?`).get(alice.agent_id) as
      { channel_session_id: string | null }
    expect(row.channel_session_id).toBeNull()
    db.close()
  })

  it('returns unknown_agent when caller is not registered', () => {
    const { dir, db, svc } = setup(); cleanups.push(dir)
    const res = svc.bind({
      callerAgentId: 'ghost',
      team: 'default',
      name: 'alice',
      channel_session_id: 'csid-abc'
    })
    expect(res).toEqual({ error: 'unknown_agent' })
    db.close()
  })

  it('returns invalid_channel_session_id when csid is blank', () => {
    const { dir, db, repo, svc } = setup(); cleanups.push(dir)
    const proxy = repo.register({ model: 'proxy', role: '__channel_proxy__', name: 'p1' })
    const res = svc.bind({
      callerAgentId: proxy.agent_id,
      team: 'default',
      name: 'alice',
      channel_session_id: '   '
    })
    expect(res).toEqual({ error: 'invalid_channel_session_id' })
    db.close()
  })
})
