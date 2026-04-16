import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { TaskAddService } from '../src/mcp/task-add.js'
import { TaskClaimService } from '../src/mcp/task-claim.js'
import { TaskCompleteService } from '../src/mcp/task-complete.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('task_complete', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  function setup() {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    agents.register({ agent_id: 'A', model: 'm', role: 'r' })
    agents.register({ agent_id: 'B', model: 'm', role: 'r' })
    const events = new EventsOutbox(db)
    return {
      db,
      add: new TaskAddService(db, agents, events),
      claim: new TaskClaimService(db, agents, events),
      complete: new TaskCompleteService(db, agents, events)
    }
  }

  it('owner completes task and row updates', () => {
    const { db, add, claim, complete } = setup()
    const { task_id } = add.add({ caller: 'A', title: 't' }) as { task_id: string }
    claim.claim({ caller: 'A', task_id })
    const r = complete.complete({ caller: 'A', task_id, result: 'done' })
    expect(r).toEqual({ ok: true })
    const row = db.prepare('SELECT status, result FROM tasks WHERE id=?').get(task_id) as { status: string; result: string }
    expect(row.status).toBe('completed')
    expect(row.result).toBe('done')
  })

  it('non-owner returns not_owner', () => {
    const { add, claim, complete } = setup()
    const { task_id } = add.add({ caller: 'A', title: 't' }) as { task_id: string }
    claim.claim({ caller: 'A', task_id })
    const r = complete.complete({ caller: 'B', task_id })
    expect(r).toEqual({ error: 'not_owner' })
  })

  it('pending task returns invalid_status', () => {
    const { add, complete } = setup()
    const { task_id } = add.add({ caller: 'A', title: 't' }) as { task_id: string }
    const r = complete.complete({ caller: 'A', task_id })
    expect(r).toEqual({ error: 'invalid_status' })
  })
})
