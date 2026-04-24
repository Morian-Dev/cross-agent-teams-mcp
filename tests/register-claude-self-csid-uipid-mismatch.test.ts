import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ChannelWakeFanout } from '../src/daemon/channel-wake-fanout.js'
import { registerBusinessTools } from '../src/mcp/tools.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'
import { AgentsRepo } from '../src/storage/agents-repo.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-rcs-mismatch-'))

const { detectTmuxPaneMock, bindRuntimeIdentityMock } = vi.hoisted(() => ({
  detectTmuxPaneMock: vi.fn(),
  bindRuntimeIdentityMock: vi.fn(),
}))

vi.mock('../src/daemon/tmux-pane-detect.js', () => ({
  detectTmuxPane: detectTmuxPaneMock,
}))
vi.mock('../src/daemon/runtime-identity.js', () => ({
  bindRuntimeIdentity: bindRuntimeIdentityMock,
}))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

async function setup(channelWakeFanout?: ChannelWakeFanout) {
  const dir = tmp()
  const dbPath = join(dir, 'data.db')
  const db = openDb(dbPath)
  applySchema(db)
  const server = new McpServer({ name: 'test-server', version: '0.0.0' })
  const holder: { current: string | undefined } = { current: undefined }
  const sessionId = 'session-mismatch'
  registerBusinessTools(
    server,
    db,
    () => holder.current ?? sessionId,
    undefined,
    (agentId) => { holder.current = agentId },
    () => sessionId,
    channelWakeFanout,
  )
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await server.connect(st)
  const client = new Client({ name: 'fake-claude-code', version: '0.0.0' })
  await client.connect(ct)
  return { dir, db, server, client, transport: ct, repo: new AgentsRepo(db) }
}

function seedLiveProxy(
  repo: AgentsRepo,
  fanout: ChannelWakeFanout,
  args: { team?: string; csid: string; claude_ui_pid: number; name?: string }
): void {
  repo.register({
    client: 'custom',
    client_name: 'cross-agent-teams-channel',
    model: 'proxy',
    role: '__channel_proxy__',
    name: args.name ?? `proxy-${args.claude_ui_pid}`,
    team: args.team ?? 'default',
    claude_ui_pid: args.claude_ui_pid,
    delivery: { kind: 'claude-channel', channel_session_id: args.csid },
  })
  fanout.attach(args.csid, () => { /* sink */ }, `sess-${args.csid}`)
}

describe('register_claude_self csid vs ui_pid consistency check', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    detectTmuxPaneMock.mockReset()
    bindRuntimeIdentityMock.mockReset()
  })

  it('rejects with channel_session_id_ui_pid_mismatch when csid differs from live proxy (a)', async () => {
    bindRuntimeIdentityMock.mockResolvedValue({ error: 'pid_not_found' })
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    const fanout = new ChannelWakeFanout()
    const { dir, db, server, client, transport, repo } = await setup(fanout)
    cleanups.push(dir)
    seedLiveProxy(repo, fanout, { csid: 'csid-real', claude_ui_pid: 25424 })
    fanout.attach('csid-stale', () => { /* sink */ }, 'sess-stale')

    const obj = await parseTool(await client.callTool({
      name: 'register_claude_self',
      arguments: { name: 'opus', ui_pid: 25424, channel_session_id: 'csid-stale' },
    }))
    expect(obj.error).toBe('channel_session_id_ui_pid_mismatch')
    expect(obj.detail).toEqual({
      ui_pid_matched_csid: 'csid-real',
      supplied_csid: 'csid-stale',
    })
    // No agent row should have been written for 'opus'
    const row = db.prepare(
      `SELECT COUNT(*) AS n FROM agents WHERE name='opus'`
    ).get() as { n: number }
    expect(row.n).toBe(0)
    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('proceeds and binds when supplied csid matches the live proxy (b)', async () => {
    bindRuntimeIdentityMock.mockResolvedValue({ error: 'pid_not_found' })
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    const fanout = new ChannelWakeFanout()
    const { dir, db, server, client, transport, repo } = await setup(fanout)
    cleanups.push(dir)
    seedLiveProxy(repo, fanout, { csid: 'csid-ok', claude_ui_pid: 25424 })

    const obj = await parseTool(await client.callTool({
      name: 'register_claude_self',
      arguments: { name: 'opus', ui_pid: 25424, channel_session_id: 'csid-ok' },
    }))
    expect(obj.agent_id).toBeDefined()
    expect(obj.error).toBeUndefined()
    const row = db.prepare(
      `SELECT delivery_kind, delivery_payload FROM agents WHERE name='opus'`
    ).get() as { delivery_kind: string; delivery_payload: string | null }
    expect(row.delivery_kind).toBe('claude-channel')
    expect(JSON.parse(row.delivery_payload as string)).toEqual({ channel_session_id: 'csid-ok' })
    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('proceeds to explicit-bind when no live proxy row exists for ui_pid (c)', async () => {
    bindRuntimeIdentityMock.mockResolvedValue({ error: 'pid_not_found' })
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    const fanout = new ChannelWakeFanout()
    const { dir, db, server, client, transport } = await setup(fanout)
    cleanups.push(dir)
    fanout.attach('csid-explicit', () => { /* sink */ }, 'sess-explicit')

    const obj = await parseTool(await client.callTool({
      name: 'register_claude_self',
      arguments: { name: 'opus', ui_pid: 99999, channel_session_id: 'csid-explicit' },
    }))
    expect(obj.agent_id).toBeDefined()
    expect(obj.error).toBeUndefined()
    const row = db.prepare(
      `SELECT delivery_kind, delivery_payload FROM agents WHERE name='opus'`
    ).get() as { delivery_kind: string; delivery_payload: string | null }
    expect(row.delivery_kind).toBe('claude-channel')
    expect(JSON.parse(row.delivery_payload as string)).toEqual({ channel_session_id: 'csid-explicit' })
    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('proceeds to explicit-bind when proxy row is older than 5 minutes (d)', async () => {
    bindRuntimeIdentityMock.mockResolvedValue({ error: 'pid_not_found' })
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    const fanout = new ChannelWakeFanout()
    const { dir, db, server, client, transport, repo } = await setup(fanout)
    cleanups.push(dir)
    repo.register({
      client: 'custom',
      model: 'proxy',
      role: '__channel_proxy__',
      name: 'proxy-stale',
      team: 'default',
      claude_ui_pid: 25424,
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-stale-proxy' },
    })
    const oldIso = new Date(Date.now() - 6 * 60 * 1000).toISOString()
    db.prepare(`UPDATE agents SET last_seen_at=? WHERE name='proxy-stale'`).run(oldIso)
    fanout.attach('csid-explicit', () => { /* sink */ }, 'sess-explicit')

    const obj = await parseTool(await client.callTool({
      name: 'register_claude_self',
      arguments: { name: 'opus', ui_pid: 25424, channel_session_id: 'csid-explicit' },
    }))
    expect(obj.agent_id).toBeDefined()
    expect(obj.error).toBeUndefined()
    const row = db.prepare(
      `SELECT delivery_kind, delivery_payload FROM agents WHERE name='opus'`
    ).get() as { delivery_kind: string; delivery_payload: string | null }
    expect(row.delivery_kind).toBe('claude-channel')
    expect(JSON.parse(row.delivery_payload as string)).toEqual({ channel_session_id: 'csid-explicit' })
    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('mismatch check ignores team: proxy in team A rejects caller in team B with wrong csid (e)', async () => {
    bindRuntimeIdentityMock.mockResolvedValue({ error: 'pid_not_found' })
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    const fanout = new ChannelWakeFanout()
    const { dir, db, server, client, transport, repo } = await setup(fanout)
    cleanups.push(dir)
    // Proxy lives in team 'default' (the proxy always registers into 'default'
    // per the channel-proxy startup sequence spec).  Caller registers into a
    // different team 'alpha'.  Auto-bind / mismatch lookup is by claude_ui_pid
    // alone, so the proxy row IS matched and the csid mismatch IS rejected.
    seedLiveProxy(repo, fanout, { csid: 'csid-real', claude_ui_pid: 25424, team: 'default' })

    const obj = await parseTool(await client.callTool({
      name: 'register_claude_self',
      arguments: {
        name: 'opus',
        team: 'alpha',
        ui_pid: 25424,
        channel_session_id: 'csid-wrong',
      },
    }))
    expect(obj.error).toBe('channel_session_id_ui_pid_mismatch')
    expect(obj.detail).toEqual({
      ui_pid_matched_csid: 'csid-real',
      supplied_csid: 'csid-wrong',
    })
    const row = db.prepare(
      `SELECT COUNT(*) as c FROM agents WHERE name='opus'`
    ).get() as { c: number }
    expect(row.c).toBe(0)
    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('does not fire when only csid is supplied without ui_pid (5.3 partial)', async () => {
    bindRuntimeIdentityMock.mockResolvedValue({ error: 'pid_not_found' })
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    const fanout = new ChannelWakeFanout()
    const { dir, db, server, client, transport, repo } = await setup(fanout)
    cleanups.push(dir)
    // Proxy exists for a pid but caller does not pass ui_pid.
    seedLiveProxy(repo, fanout, { csid: 'csid-proxy', claude_ui_pid: 25424 })
    fanout.attach('csid-explicit', () => { /* sink */ }, 'sess-explicit')

    const obj = await parseTool(await client.callTool({
      name: 'register_claude_self',
      arguments: { name: 'opus', channel_session_id: 'csid-explicit' },
    }))
    expect(obj.agent_id).toBeDefined()
    expect(obj.error).toBeUndefined()
    const row = db.prepare(
      `SELECT delivery_kind, delivery_payload FROM agents WHERE name='opus'`
    ).get() as { delivery_kind: string; delivery_payload: string | null }
    expect(row.delivery_kind).toBe('claude-channel')
    expect(JSON.parse(row.delivery_payload as string)).toEqual({ channel_session_id: 'csid-explicit' })
    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })
})
