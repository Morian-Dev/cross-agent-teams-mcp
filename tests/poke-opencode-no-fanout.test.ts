import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const { sendOpencodePrompt } = vi.hoisted(() => ({
  sendOpencodePrompt: vi.fn(async () => ({ ok: true as const })),
}))

vi.mock('../src/mcp/opencode-transport.js', () => ({
  sendOpencodePrompt,
}))

import { poke } from '../src/mcp/poke.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-poke-opencode-no-fanout-'))

function seedAgent(db: ReturnType<typeof openDb>, args: {
  agent_id: string
  name: string
  pane?: string | null
  client?: string | null
  opencode_base_url?: string | null
  opencode_session_id?: string | null
}): void {
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO agents (
       agent_id, client, team, role, name, model, registered_at, last_seen_at,
       tmux_pane_id, opencode_base_url, opencode_session_id, delivery_kind, delivery_payload
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    args.agent_id,
    args.client ?? null,
    'default',
    'dev',
    args.name,
    'm',
    now,
    now,
    args.pane ?? null,
    args.opencode_base_url ?? null,
    args.opencode_session_id ?? null,
    'none',
    null,
  )
}

describe('poke opencode transport without fanout', () => {
  const dirs: string[] = []

  afterEach(() => {
    dirs.forEach(d => rmSync(d, { recursive: true, force: true }))
    dirs.length = 0
    sendOpencodePrompt.mockClear()
  })

  it('uses opencode-server when target has bound opencode session', async () => {
    const dir = tmp()
    dirs.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    seedAgent(db, { agent_id: 'A', name: 'alice', pane: '%1' })
    seedAgent(db, {
      agent_id: 'B',
      name: 'bob',
      client: 'opencode',
      opencode_base_url: 'http://127.0.0.1:4096',
      opencode_session_id: 'sess-b',
    })

    const res = await poke(
      { db, callerAgentId: 'A' },
      { target_agent_id: 'B', prompt: 'wake up' }
    )

    expect(res).toEqual({
      ok: true,
      transport_used: 'opencode-server',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'sess-b',
    })
    expect(sendOpencodePrompt).toHaveBeenCalledWith({
      base_url: 'http://127.0.0.1:4096',
      session_id: 'sess-b',
      prompt: 'wake up',
    })
    db.close()
  })
})
