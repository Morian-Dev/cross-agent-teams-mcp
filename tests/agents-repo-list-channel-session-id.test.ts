import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('AgentsRepo.list channel_session_id', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('list() returns channel_session_id for each agent (string or null)', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    const repo = new AgentsRepo(db)
    const a = repo.register({
      model: 'opus', role: 'backend', name: 'alice',
      channel_session_id: 'csid-abc'
    })
    const b = repo.register({
      model: 'sonnet', role: 'backend', name: 'bob'
    })
    const rows = repo.list({ team: 'default' })
    const aRow = rows.find(r => r.agent_id === a.agent_id)
    const bRow = rows.find(r => r.agent_id === b.agent_id)
    expect(aRow?.channel_session_id).toBe('csid-abc')
    expect(bRow?.channel_session_id).toBeNull()
    db.close()
  })
})
