import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-agents-delivery-'))

describe('AgentsRepo delivery integration', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  function setup() {
    const dir = tmp()
    cleanups.push(dir)
    const db = openDb(join(dir, 'data.db'))
    applySchema(db)
    return { db, repo: new AgentsRepo(db) }
  }

  it('register reads back delivery for none, claude-channel, and codex-appserver', () => {
    const { db, repo } = setup()
    const none = repo.register({ model: 'opus', role: 'backend', name: 'none-agent' })
    const claude = repo.register({
      model: 'opus',
      role: 'backend',
      name: 'claude-agent',
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-abc' },
    })
    const codex = repo.register({
      model: 'opus',
      role: 'backend',
      name: 'codex-agent',
      delivery: {
        kind: 'codex-appserver',
        thread_id: 'thread-123',
        ws_url: 'wss://example.test/ws',
        auth_token_ref: 'token-ref',
      },
    })

    expect(repo.getById(none.agent_id)?.delivery).toEqual({ kind: 'none' })
    expect(repo.getById(claude.agent_id)?.delivery).toEqual({
      kind: 'claude-channel',
      channel_session_id: 'csid-abc',
    })
    expect(repo.getById(codex.agent_id)?.delivery).toEqual({
      kind: 'codex-appserver',
      thread_id: 'thread-123',
      ws_url: 'wss://example.test/ws',
      auth_token_ref: 'token-ref',
    })

    const row = db.prepare(
      `SELECT delivery_kind, delivery_payload FROM agents WHERE agent_id=?`
    ).get(claude.agent_id) as {
      delivery_kind: string
      delivery_payload: string | null
    }
    expect(row.delivery_kind).toBe('claude-channel')
    expect(JSON.parse(row.delivery_payload as string)).toEqual({
      channel_session_id: 'csid-abc',
    })
    db.close()
  })

  it('setDelivery overwrites prior delivery atomically', () => {
    const { db, repo } = setup()
    const alice = repo.register({ model: 'opus', role: 'backend', name: 'alice' })

    repo.setDelivery(alice.agent_id, {
      kind: 'claude-channel',
      channel_session_id: 'csid-first',
    })
    repo.setDelivery(alice.agent_id, {
      kind: 'codex-appserver',
      thread_id: 'thread-456',
      ws_url: 'wss://example.test/next',
    })

    expect(repo.getById(alice.agent_id)?.delivery).toEqual({
      kind: 'codex-appserver',
      thread_id: 'thread-456',
      ws_url: 'wss://example.test/next',
    })
    const row = db.prepare(
      `SELECT delivery_kind, delivery_payload FROM agents WHERE agent_id=?`
    ).get(alice.agent_id) as {
      delivery_kind: string
      delivery_payload: string | null
    }
    expect(row.delivery_kind).toBe('codex-appserver')
    expect(JSON.parse(row.delivery_payload as string)).toEqual({
      thread_id: 'thread-456',
      ws_url: 'wss://example.test/next',
    })
    db.close()
  })

  it('derived channel_session_id follows delivery kind in getById and list', () => {
    const { db, repo } = setup()
    const alice = repo.register({
      model: 'opus',
      role: 'backend',
      name: 'alice',
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-xyz' },
    })
    const bob = repo.register({
      model: 'opus',
      role: 'backend',
      name: 'bob',
      delivery: {
        kind: 'codex-appserver',
        thread_id: 'thread-789',
        ws_url: 'wss://example.test/codex',
      },
    })

    expect(repo.getById(alice.agent_id)?.channel_session_id).toBe('csid-xyz')
    expect(repo.getById(bob.agent_id)?.channel_session_id).toBeNull()

    const rows = repo.list({ team: 'default' })
    expect(rows.find(row => row.agent_id === alice.agent_id)?.channel_session_id).toBe(
      'csid-xyz'
    )
    expect(rows.find(row => row.agent_id === bob.agent_id)?.channel_session_id).toBeNull()
    db.close()
  })
})
