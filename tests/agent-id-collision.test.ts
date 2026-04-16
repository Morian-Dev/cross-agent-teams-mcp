import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { RegisterAgentService } from '../src/mcp/register-agent.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('agent_id collision', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('different connection presenting same session id returns collision', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const svc = new RegisterAgentService(db)
    const ok = svc.register({ agent_id: 'sess-A', connection_id: 'conn-1', model: 'm', role: 'r' })
    expect(ok).toEqual({ agent_id: 'sess-A', team: 'default' })
    const dup = svc.register({ agent_id: 'sess-A', connection_id: 'conn-2', model: 'm', role: 'r' })
    expect(dup).toEqual({ error: 'agent_id_collision' })
  })

  it('same connection re-registering is ok', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const svc = new RegisterAgentService(db)
    svc.register({ agent_id: 'sess-A', connection_id: 'conn-1', model: 'm', role: 'r' })
    const again = svc.register({ agent_id: 'sess-A', connection_id: 'conn-1', model: 'm', role: 'r', display_name: 'alice' })
    expect(again).toEqual({ agent_id: 'sess-A', team: 'default' })
  })
})
