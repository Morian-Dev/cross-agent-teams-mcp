import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerBusinessTools } from '../src/mcp/tools.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'

// reconnect's single-match path drives the claude-code register path, which runs
// the ui_pid preflight + auto runtime binding. Stub those daemon modules so the
// test does not depend on a live process / tmux.
vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: vi.fn(async () => ({ error: 'not_found', candidates: [] })),
}))
vi.mock('../src/daemon/runtime-identity.js', () => ({
  bindRuntimeIdentity: vi.fn(async () => ({
    ok: true,
    tmux_pane_id: '%1',
    verification_mode: 'verified_pid_tty_pane',
    tty: 'ttys001',
    ui_pid: 25079,
  })),
}))

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-reconnect-tool-'))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

async function setup(opts: { localDevice?: string } = {}) {
  const dir = tmp()
  const dbPath = join(dir, 'data.db')
  const db = openDb(dbPath)
  const localDevice = opts.localDevice ?? 'local'
  applySchema(db, { localDevice })
  const server = new McpServer({ name: 'test-server', version: '0.0.0' })
  const holder: { current: string | undefined } = { current: undefined }
  const sessionId = 'session-reconnect'
  registerBusinessTools(
    server,
    db,
    () => holder.current ?? sessionId,
    undefined,
    (agentId) => { holder.current = agentId },
    () => sessionId,
    undefined,
    undefined,
    undefined,
    undefined,
    { localDevice },
  )
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: 'claude-code', version: '0.0.0' })
  await client.connect(ct)
  return { dir, db, server, client, transport: ct, repo: new AgentsRepo(db) }
}

function seedAgent(
  db: ReturnType<typeof openDb>,
  args: {
    agent_id: string
    device?: string
    team?: string
    name: string
    runtime_ui_pid: number | null
    last_seen_at: string
    registered_at?: string
    last_processed_event_id?: number
  }
): void {
  db.prepare(
    `INSERT INTO agents (
       agent_id, agent_type, device, team, role, name, registered_at, last_seen_at,
       runtime_ui_pid, last_processed_event_id
     ) VALUES (?, 'claude-code', ?, ?, 'worker', ?, ?, ?, ?, ?)`
  ).run(
    args.agent_id,
    args.device ?? 'local',
    args.team ?? 'default',
    args.name,
    args.registered_at ?? args.last_seen_at,
    args.last_seen_at,
    args.runtime_ui_pid,
    args.last_processed_event_id ?? 0,
  )
}

describe('reconnect tool', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('single match reuses agent_id, refreshes last_seen_at, keeps registered_at + cursor', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    const REGISTERED_AT = '2024-01-01T00:00:00.000Z'
    const LAST_SEEN = '2024-01-02T00:00:00.000Z'
    seedAgent(db, {
      agent_id: 'X',
      name: 'xats-creator',
      runtime_ui_pid: 25079,
      last_seen_at: LAST_SEEN,
      registered_at: REGISTERED_AT,
      last_processed_event_id: 42,
    })

    const resp = await client.callTool({ name: 'reconnect', arguments: { ui_pid: 25079 } })
    const obj = await parseTool(resp)

    expect(obj.ok).toBe(true)
    expect(obj.agent_id).toBe('X')
    expect(obj.name).toBe('xats-creator')
    expect(obj.team).toBe('default')
    expect(obj.last_seen_at).toBe(LAST_SEEN)
    expect('channel_session_id' in obj).toBe(true)

    const row = db.prepare(
      `SELECT agent_id, registered_at, last_seen_at, last_processed_event_id
       FROM agents WHERE team='default' AND name='xats-creator'`
    ).get() as {
      agent_id: string
      registered_at: string
      last_seen_at: string
      last_processed_event_id: number
    }
    expect(row.agent_id).toBe('X')
    expect(row.registered_at).toBe(REGISTERED_AT)
    expect(row.last_processed_event_id).toBe(42)
    expect(row.last_seen_at).not.toBe(LAST_SEEN)

    const count = db.prepare(
      `SELECT COUNT(*) AS c FROM agents WHERE name='xats-creator'`
    ).get() as { c: number }
    expect(count.c).toBe(1)

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('resolves a row stored under the configured local device label', async () => {
    const { dir, db, server, client, transport } = await setup({ localDevice: 'jt' })
    cleanups.push(dir)
    seedAgent(db, {
      agent_id: 'J',
      device: 'jt',
      name: 'xats-creator',
      runtime_ui_pid: 25079,
      last_seen_at: '2024-01-02T00:00:00.000Z',
    })

    const resp = await client.callTool({ name: 'reconnect', arguments: { ui_pid: 25079 } })
    const obj = await parseTool(resp)

    expect(obj.ok).toBe(true)
    expect(obj.agent_id).toBe('J')
    expect(obj.name).toBe('xats-creator')
    expect(obj.team).toBe('default')

    const row = db.prepare(
      `SELECT device FROM agents WHERE agent_id='J'`
    ).get() as { device: string }
    expect(row.device).toBe('jt')

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('zero match returns need_register without creating or mutating any row', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedAgent(db, {
      agent_id: 'Y',
      name: 'other',
      runtime_ui_pid: 11111,
      last_seen_at: '2024-01-02T00:00:00.000Z',
    })

    const before = db.prepare(`SELECT last_seen_at FROM agents WHERE agent_id='Y'`).get() as { last_seen_at: string }
    const resp = await client.callTool({ name: 'reconnect', arguments: { ui_pid: 99999 } })
    const obj = await parseTool(resp)

    expect(obj.need_register).toBe(true)
    expect(typeof obj.reason).toBe('string')
    expect(obj.ok).toBeUndefined()

    const count = db.prepare(`SELECT COUNT(*) AS c FROM agents`).get() as { c: number }
    expect(count.c).toBe(1)
    const after = db.prepare(`SELECT last_seen_at FROM agents WHERE agent_id='Y'`).get() as { last_seen_at: string }
    expect(after.last_seen_at).toBe(before.last_seen_at)

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('multiple matches return ambiguous candidates ordered by last_seen_at DESC, no mutation', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedAgent(db, {
      agent_id: 'A',
      name: 'xats-tester',
      runtime_ui_pid: 25079,
      last_seen_at: '2024-01-01T00:00:00.000Z',
    })
    seedAgent(db, {
      agent_id: 'B',
      name: 'xats-creator',
      runtime_ui_pid: 25079,
      last_seen_at: '2024-06-01T00:00:00.000Z',
    })

    const resp = await client.callTool({ name: 'reconnect', arguments: { ui_pid: 25079 } })
    const obj = await parseTool(resp)

    expect(obj.ambiguous).toBe(true)
    const candidates = obj.candidates as Array<{ name: string; last_seen_at: string }>
    expect(candidates.map(c => c.name)).toEqual(['xats-creator', 'xats-tester'])
    expect(candidates[0].last_seen_at).toBe('2024-06-01T00:00:00.000Z')

    // No mutation: both seeded last_seen_at values unchanged.
    const rows = db.prepare(`SELECT agent_id, last_seen_at FROM agents ORDER BY agent_id`).all() as Array<{
      agent_id: string
      last_seen_at: string
    }>
    expect(rows).toEqual([
      { agent_id: 'A', last_seen_at: '2024-01-01T00:00:00.000Z' },
      { agent_id: 'B', last_seen_at: '2024-06-01T00:00:00.000Z' },
    ])

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('does not match a remote-device row for the same ui_pid (returns need_register)', async () => {
    const { dir, db, server, client, transport } = await setup()
    cleanups.push(dir)
    seedAgent(db, {
      agent_id: 'R',
      device: 'gx',
      name: 'remote-alice',
      runtime_ui_pid: 25079,
      last_seen_at: '2024-01-02T00:00:00.000Z',
    })

    const resp = await client.callTool({ name: 'reconnect', arguments: { ui_pid: 25079 } })
    const obj = await parseTool(resp)

    expect(obj.need_register).toBe(true)
    expect(obj.ok).toBeUndefined()

    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })
})
