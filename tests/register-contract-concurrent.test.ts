import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { RegisterContractService } from '../src/mcp/register-contract.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('register_contract concurrent', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('100 concurrent registrations produce versions 1..100 with no gap', async () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    agents.register({ agent_id: 'A', model: 'm', role: 'r' })
    const svc = new RegisterContractService(db, agents, new EventsOutbox(db))
    const N = 100
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        Promise.resolve().then(() =>
          svc.register({ caller: 'A', name: 'X', schema: { type: 'object', properties: { n: { const: i } } } })
        )
      )
    )
    const versions = results.map(r => (r as { version: number }).version).sort((a, b) => a - b)
    expect(versions).toEqual(Array.from({ length: N }, (_, i) => i + 1))
    const dbRows = db.prepare('SELECT version FROM contracts WHERE name=? ORDER BY version').all('X') as Array<{ version: number }>
    expect(dbRows.map(r => r.version)).toEqual(versions)
  }, 30000)
})
