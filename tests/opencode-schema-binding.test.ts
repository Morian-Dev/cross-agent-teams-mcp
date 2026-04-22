import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { BindOpencodeSessionService } from '../src/mcp/bind-opencode-session.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('opencode schema and binding', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('creates opencode_base_url and opencode_session_id columns on fresh db', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const cols = db.pragma('table_info(agents)') as Array<{ name: string; type: string; notnull: number }>
    const baseUrl = cols.find(c => c.name === 'opencode_base_url')
    const sessionId = cols.find(c => c.name === 'opencode_session_id')
    expect(baseUrl).toBeDefined()
    expect(baseUrl?.type).toBe('TEXT')
    expect(baseUrl?.notnull).toBe(0)
    expect(sessionId).toBeDefined()
    expect(sessionId?.type).toBe('TEXT')
    expect(sessionId?.notnull).toBe(0)
    db.close()
  })

  it('defaults opencode columns to NULL on insert', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const repo = new AgentsRepo(db)
    const alice = repo.register({ model: 'opus', role: 'backend', name: 'alice' })
    const row = repo.getById(alice.agent_id)
    expect(row?.opencode_base_url).toBeNull()
    expect(row?.opencode_session_id).toBeNull()
    db.close()
  })

  it('list_agents returns opencode fields', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const repo = new AgentsRepo(db)
    repo.register({ model: 'opus', role: 'backend', name: 'alice' })
    repo.register({ model: 'opus', role: 'backend', name: 'bob' })

    const svc = new BindOpencodeSessionService(db)
    const alice = repo.findByIdentity({ team: 'default', name: 'alice' })!
    svc.bind({
      callerAgentId: alice.agent_id,
      base_url: 'http://127.0.0.1:4096',
      session_id: 'sess-abc'
    })

    const agents = repo.list({ team: 'default' })
    const aliceRow = agents.find(a => a.name === 'alice')
    const bobRow = agents.find(a => a.name === 'bob')
    expect(aliceRow?.opencode_base_url).toBe('http://127.0.0.1:4096')
    expect(aliceRow?.opencode_session_id).toBe('sess-abc')
    expect(bobRow?.opencode_base_url).toBeNull()
    expect(bobRow?.opencode_session_id).toBeNull()
    db.close()
  })

  it('bind_opencode_session persists to caller row', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const repo = new AgentsRepo(db)
    const svc = new BindOpencodeSessionService(db)
    const alice = repo.register({ model: 'opus', role: 'backend', name: 'alice' })

    const res = svc.bind({
      callerAgentId: alice.agent_id,
      base_url: 'http://localhost:4096',
      session_id: 'sess-xyz'
    })

    expect(res).toEqual({ ok: true })
    const row = repo.getById(alice.agent_id)
    expect(row?.opencode_base_url).toBe('http://localhost:4096')
    expect(row?.opencode_session_id).toBe('sess-xyz')
    db.close()
  })

  it('bind_opencode_session rejects non-loopback base_url', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const repo = new AgentsRepo(db)
    const svc = new BindOpencodeSessionService(db)
    const alice = repo.register({ model: 'opus', role: 'backend', name: 'alice' })

    const res = svc.bind({
      callerAgentId: alice.agent_id,
      base_url: 'http://10.0.0.5:4096',
      session_id: 'sess-abc'
    })

    expect(res).toEqual({ error: 'invalid_opencode_base_url' })
    const row = repo.getById(alice.agent_id)
    expect(row?.opencode_base_url).toBeNull()
    expect(row?.opencode_session_id).toBeNull()
    db.close()
  })

  it('bind_opencode_session rejects blank session id', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const repo = new AgentsRepo(db)
    const svc = new BindOpencodeSessionService(db)
    const alice = repo.register({ model: 'opus', role: 'backend', name: 'alice' })

    const res = svc.bind({
      callerAgentId: alice.agent_id,
      base_url: 'http://localhost:4096',
      session_id: '   '
    })

    expect(res).toEqual({ error: 'invalid_opencode_session_id' })
    const row = repo.getById(alice.agent_id)
    expect(row?.opencode_base_url).toBeNull()
    expect(row?.opencode_session_id).toBeNull()
    db.close()
  })

  it('bind_opencode_session returns unknown_agent for unregistered caller', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const svc = new BindOpencodeSessionService(db)

    const res = svc.bind({
      callerAgentId: 'ghost-id',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'sess-abc'
    })

    expect(res).toEqual({ error: 'unknown_agent' })
    db.close()
  })
})
