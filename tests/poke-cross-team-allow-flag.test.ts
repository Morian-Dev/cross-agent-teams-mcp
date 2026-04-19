import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

vi.mock('../src/daemon/tmux-cli.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/daemon/tmux-cli.js')>()
  return {
    ...actual,
    isTmuxAvailable: vi.fn(async () => true),
    capturePaneTail: vi.fn(async () => 'tail'),
    loadBuffer: vi.fn(async () => {}),
    pasteBuffer: vi.fn(async () => {}),
    sendEnter: vi.fn(async () => {})
  }
})

import { poke } from '../src/mcp/poke.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-poke-xteam-'))

function seed(db: ReturnType<typeof openDb>, agent_id: string, team: string, name: string, pane: string | null): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO agents (agent_id, team, role, name, model, registered_at, last_seen_at, tmux_pane_id)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(agent_id, team, 'r', name, null, now, now, pane)
}

describe('poke() cross-team with allowCrossTeam flag', () => {
  const dirs: string[] = []
  afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

  function fresh(): ReturnType<typeof openDb> {
    const dir = tmp(); dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    return db
  }

  it('without allowCrossTeam, cross-team caller gets cross_team_denied', async () => {
    const db = fresh()
    seed(db, 'A', 'alpha', 'alice', '%pA')
    seed(db, 'B', 'beta', 'bob', '%pB')
    const res = await poke({ db, callerAgentId: 'A' }, { target_agent_id: 'B', prompt: 'p' })
    expect(res).toEqual({ error: 'cross_team_denied' })
  })

  it('with allowCrossTeam:true, cross-team caller proceeds to tmux pipeline and returns ok', async () => {
    const db = fresh()
    seed(db, 'A', 'alpha', 'alice', '%pA')
    seed(db, 'B', 'beta', 'bob', '%pB')
    const res = await poke(
      { db, callerAgentId: 'A', allowCrossTeam: true },
      { target_agent_id: 'B', prompt: 'p' }
    )
    expect('ok' in res && res.ok).toBe(true)
  })

  it('same-team caller is unaffected by the flag (still ok)', async () => {
    const db = fresh()
    seed(db, 'A', 'alpha', 'alice', '%pA')
    seed(db, 'B', 'alpha', 'bob', '%pB')
    const res = await poke({ db, callerAgentId: 'A' }, { target_agent_id: 'B', prompt: 'p' })
    expect('ok' in res && res.ok).toBe(true)
  })
})
