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

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('task_claim', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  function setup() {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    agents.register({ agent_id: 'A', model: 'm', role: 'r' })
    agents.register({ agent_id: 'B', model: 'm', role: 'r' })
    const events = new EventsOutbox(db)
    const add = new TaskAddService(db, agents, events)
    const claim = new TaskClaimService(db, agents, events)
    return { db, agents, events, add, claim }
  }

  it('claim succeeds when pending and no deps', () => {
    const { add, claim } = setup()
    const { task_id } = add.add({ caller: 'A', title: 't' }) as { task_id: string }
    const r = claim.claim({ caller: 'A', task_id })
    expect(r).toEqual({ ok: true })
  })

  it('claim fails with owner when already claimed', () => {
    const { add, claim } = setup()
    const { task_id } = add.add({ caller: 'A', title: 't' }) as { task_id: string }
    claim.claim({ caller: 'A', task_id })
    const r = claim.claim({ caller: 'B', task_id })
    expect(r).toEqual({ error: 'already_claimed', owner: 'A' })
  })

  it('claim fails when dependency is not completed', () => {
    const { add, claim } = setup()
    const t1 = (add.add({ caller: 'A', title: 't1' }) as { task_id: string }).task_id
    claim.claim({ caller: 'A', task_id: t1 })
    const t2 = (add.add({ caller: 'A', title: 't2', depends_on: [t1] }) as { task_id: string }).task_id
    const r = claim.claim({ caller: 'B', task_id: t2 })
    expect(r).toEqual({ error: 'dependencies_pending' })
  })

  it('claim on unknown id returns unknown_task', () => {
    const { claim } = setup()
    const r = claim.claim({ caller: 'A', task_id: 'does-not-exist' })
    expect(r).toEqual({ error: 'unknown_task' })
  })
})
