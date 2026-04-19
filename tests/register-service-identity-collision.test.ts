import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { RegisterAgentService } from '../src/mcp/register-agent.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-reg-service-identity-'))

describe('RegisterAgentService identity is (team, name)', () => {
  const dirs: string[] = []
  afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

  function fresh(): RegisterAgentService {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    return new RegisterAgentService(db)
  }

  it('second session with same (team, name) different role gets agent_id_collision', () => {
    const svc = fresh()
    const r1 = svc.register({ connection_id: 'sess-A', model: 'opus', name: 'alice', role: 'backend', team: 'default' })
    expect('agent_id' in r1).toBe(true)
    const r2 = svc.register({ connection_id: 'sess-B', model: 'opus', name: 'alice', role: 'frontend', team: 'default' })
    expect(r2).toEqual({ error: 'agent_id_collision' })
  })

  it('same session re-registering same (team, name) with new role is a reuse, not collision', () => {
    const svc = fresh()
    const r1 = svc.register({ connection_id: 'sess-A', model: 'opus', name: 'alice', role: 'backend', team: 'default' })
    const id1 = (r1 as { agent_id: string }).agent_id
    const r2 = svc.register({ connection_id: 'sess-A', model: 'opus', name: 'alice', role: 'frontend', team: 'default' })
    expect('agent_id' in r2).toBe(true)
    expect((r2 as { agent_id: string }).agent_id).toBe(id1)
  })

  it('after releaseConnection, a different session can take over (team, name)', () => {
    const svc = fresh()
    const r1 = svc.register({ connection_id: 'sess-A', model: 'opus', name: 'alice', role: 'backend', team: 'default' })
    const id1 = (r1 as { agent_id: string }).agent_id
    svc.releaseConnection(id1, 'sess-A')
    const r2 = svc.register({ connection_id: 'sess-B', model: 'opus', name: 'alice', role: 'frontend', team: 'default' })
    expect('agent_id' in r2).toBe(true)
    expect((r2 as { agent_id: string }).agent_id).toBe(id1)
  })
})
