import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'
import { EventsOutbox } from '../src/storage/events-outbox.js'
import { TaskAddService } from '../src/mcp/task-add.js'
import { TaskListService } from '../src/mcp/task-list.js'
import { insertAgent } from './helpers/insert-agent.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-'))

describe('task_list', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('filters by pending and is team-scoped', () => {
    const dir = tmp(); cleanups.push(dir)
    const db = openDb(join(dir, 'data.db')); applySchema(db)
    const agents = new AgentsRepo(db)
    insertAgent(db, { agent_id: 'A', model: 'm', role: 'r', team: 'alpha' , name: 'A' })
    insertAgent(db, { agent_id: 'X', model: 'm', role: 'r', team: 'beta' , name: 'X' })
    const add = new TaskAddService(db, agents, new EventsOutbox(db))
    add.add({ caller: 'A', title: 'a1' })
    add.add({ caller: 'A', title: 'a2' })
    add.add({ caller: 'X', title: 'b1' })
    const list = new TaskListService(db, agents)
    const alphaPending = list.list({ caller: 'A', status: 'pending' })
    expect(alphaPending.tasks.map(t => t.title).sort()).toEqual(['a1','a2'])
    const alphaAll = list.list({ caller: 'A' })
    expect(alphaAll.tasks.length).toBe(2)
  })
})
