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

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-rcs-auto-bind-'))

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
  const sessionId = 'session-auto-bind'
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

describe('register_claude_self auto-bind via ui_pid', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
    detectTmuxPaneMock.mockReset()
    bindRuntimeIdentityMock.mockReset()
  })

  it('auto-binds when ui_pid matches a live proxy row (6.5)', async () => {
    bindRuntimeIdentityMock.mockResolvedValue({ error: 'pid_not_found' })
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    const fanout = new ChannelWakeFanout()
    const { dir, db, server, client, transport, repo } = await setup(fanout)
    cleanups.push(dir)
    seedLiveProxy(repo, fanout, { csid: 'csid-abc', claude_ui_pid: 25424 })

    const obj = await parseTool(await client.callTool({
      name: 'register_claude_self',
      arguments: { name: 'opus', ui_pid: 25424 },
    }))
    expect(obj.agent_id).toBeDefined()
    expect(obj.channel_session_id).toBe('csid-abc')
    const row = db.prepare(
      `SELECT delivery_kind, delivery_payload, runtime_ui_pid FROM agents WHERE team='default' AND name='opus'`
    ).get() as { delivery_kind: string; delivery_payload: string | null; runtime_ui_pid: number | null }
    expect(row.delivery_kind).toBe('claude-channel')
    expect(JSON.parse(row.delivery_payload as string)).toEqual({ channel_session_id: 'csid-abc' })
    expect(row.runtime_ui_pid).toBe(25424)
    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('leaves delivery=none when no proxy row matches (6.6)', async () => {
    bindRuntimeIdentityMock.mockResolvedValue({ error: 'pid_not_found' })
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    const fanout = new ChannelWakeFanout()
    const { dir, db, server, client, transport } = await setup(fanout)
    cleanups.push(dir)

    const obj = await parseTool(await client.callTool({
      name: 'register_claude_self',
      arguments: { name: 'opus', ui_pid: 99999 },
    }))
    expect(obj.agent_id).toBeDefined()
    expect(obj.channel_session_id).toBeUndefined()
    const row = db.prepare(
      `SELECT delivery_kind FROM agents WHERE name='opus'`
    ).get() as { delivery_kind: string }
    expect(row.delivery_kind).toBe('none')
    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('leaves delivery=none when matching proxy sink is dead (6.7)', async () => {
    bindRuntimeIdentityMock.mockResolvedValue({ error: 'pid_not_found' })
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    const fanout = new ChannelWakeFanout()
    const { dir, db, server, client, transport, repo } = await setup(fanout)
    cleanups.push(dir)
    // proxy row exists but no fanout attach
    repo.register({
      client: 'custom',
      model: 'proxy',
      role: '__channel_proxy__',
      name: 'proxy-dead',
      team: 'default',
      claude_ui_pid: 25424,
      delivery: { kind: 'claude-channel', channel_session_id: 'csid-dead' },
    })

    const obj = await parseTool(await client.callTool({
      name: 'register_claude_self',
      arguments: { name: 'opus', ui_pid: 25424 },
    }))
    expect(obj.agent_id).toBeDefined()
    expect(obj.channel_session_id).toBeUndefined()
    const row = db.prepare(
      `SELECT delivery_kind FROM agents WHERE name='opus'`
    ).get() as { delivery_kind: string }
    expect(row.delivery_kind).toBe('none')
    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('does not auto-bind when ui_pid is omitted (6.8)', async () => {
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    const fanout = new ChannelWakeFanout()
    const { dir, db, server, client, transport, repo } = await setup(fanout)
    cleanups.push(dir)
    seedLiveProxy(repo, fanout, { csid: 'csid-abc', claude_ui_pid: 25424 })

    const obj = await parseTool(await client.callTool({
      name: 'register_claude_self',
      arguments: { name: 'opus' },
    }))
    expect(obj.agent_id).toBeDefined()
    expect(obj.channel_session_id).toBeUndefined()
    const row = db.prepare(
      `SELECT delivery_kind FROM agents WHERE name='opus'`
    ).get() as { delivery_kind: string }
    expect(row.delivery_kind).toBe('none')
    await transport.close()
    await client.close()
    db.close()
    await server.close()
  })

  it('explicit channel_session_id bypasses auto-bind (6.9)', async () => {
    bindRuntimeIdentityMock.mockResolvedValue({ error: 'pid_not_found' })
    detectTmuxPaneMock.mockResolvedValue({ error: 'not_found', candidates: [] })
    const fanout = new ChannelWakeFanout()
    const { dir, db, server, client, transport, repo } = await setup(fanout)
    cleanups.push(dir)
    seedLiveProxy(repo, fanout, { csid: 'csid-auto', claude_ui_pid: 25424 })
    fanout.attach('csid-explicit', () => { /* sink */ }, 'sess-explicit')

    const obj = await parseTool(await client.callTool({
      name: 'register_claude_self',
      arguments: { name: 'opus', ui_pid: 25424, channel_session_id: 'csid-explicit' },
    }))
    expect(obj.agent_id).toBeDefined()
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
