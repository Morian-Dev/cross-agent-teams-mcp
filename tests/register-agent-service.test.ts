import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { RegisterAgentService } from '../src/mcp/register-agent.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-reg-svc-'))

describe('RegisterAgentService', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  function setup() {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    return { db, svc: new RegisterAgentService(db) }
  }

  it('same identity with same connection_id succeeds and reuses agent_id', () => {
    const { svc } = setup()
    const r1 = svc.register({ connection_id: 'conn-1', model: 'opus', role: 'backend', name: 'alice' })
    const r2 = svc.register({ connection_id: 'conn-1', model: 'opus', role: 'backend', name: 'alice' })
    if ('error' in r1 || 'error' in r2) throw new Error('unexpected error')
    expect(r2.agent_id).toBe(r1.agent_id)
  })

  it('same identity different connection_id returns agent_id_collision', () => {
    const { svc } = setup()
    const r1 = svc.register({ connection_id: 'conn-1', model: 'opus', role: 'backend', name: 'alice' })
    const r2 = svc.register({ connection_id: 'conn-2', model: 'opus', role: 'backend', name: 'alice' })
    if ('error' in r1) throw new Error('r1 unexpected error')
    expect(r2).toEqual({ error: 'agent_id_collision' })
  })

  it('same identity different connection succeeds after releaseConnection', () => {
    const { svc } = setup()
    const r1 = svc.register({ connection_id: 'conn-1', model: 'opus', role: 'backend', name: 'alice' })
    if ('error' in r1) throw new Error('r1 unexpected error')
    svc.releaseConnection(r1.agent_id, 'conn-1')
    const r2 = svc.register({ connection_id: 'conn-2', model: 'opus', role: 'backend', name: 'alice' })
    if ('error' in r2) throw new Error('r2 unexpected error')
    expect(r2.agent_id).toBe(r1.agent_id)
  })

  it('different identities on separate connections both succeed', () => {
    const { svc } = setup()
    const r1 = svc.register({ connection_id: 'conn-1', model: 'm', role: 'backend', name: 'alice' })
    const r2 = svc.register({ connection_id: 'conn-2', model: 'm', role: 'frontend', name: 'bob' })
    if ('error' in r1 || 'error' in r2) throw new Error('unexpected error')
    expect(r2.agent_id).not.toBe(r1.agent_id)
  })

  it('derives team from project_dir when team is omitted', () => {
    const { svc, db } = setup()
    const result = svc.register({
      connection_id: 'conn-1',
      model: 'm',
      role: 'backend',
      name: 'alice',
      project_dir: '/x/y/cross-agent-teams-mcp',
    })
    if ('error' in result) throw new Error('unexpected error')
    expect(result.team).toBe('cross-agent-teams-mcp')
    const row = db.prepare(
      'SELECT team FROM agents WHERE agent_id=?'
    ).get(result.agent_id) as { team: string }
    expect(row.team).toBe('cross-agent-teams-mcp')
  })

  it('uses explicit team before project_dir', () => {
    const { svc } = setup()
    const result = svc.register({
      connection_id: 'conn-1',
      model: 'm',
      role: 'backend',
      name: 'alice',
      team: 'alpha',
      project_dir: '/x/y/cross-agent-teams-mcp',
    })
    if ('error' in result) throw new Error('unexpected error')
    expect(result.team).toBe('alpha')
  })
})
