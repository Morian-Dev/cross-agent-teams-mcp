import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { RegisterAgentService } from '../src/mcp/register-agent.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('RegisterAgentService channel_session_id', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('forwards channel_session_id to repo and persists it', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const svc = new RegisterAgentService(db)
    const res = svc.register({
      connection_id: 'conn-1',
      model: 'opus',
      name: 'alice',
      role: 'backend',
      team: 'default',
      channel_session_id: 'csid-xyz'
    })
    expect('agent_id' in res).toBe(true)
    if ('agent_id' in res) {
      const row = db.prepare(`SELECT channel_session_id FROM agents WHERE agent_id=?`).get(res.agent_id) as
        { channel_session_id: string | null }
      expect(row.channel_session_id).toBe('csid-xyz')
    }
    db.close()
  })
})
