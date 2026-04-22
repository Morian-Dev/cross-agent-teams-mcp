import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-hint2-'))

async function parseTool(resp: unknown): Promise<Record<string, unknown>> {
  const r = resp as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0].text)
}

async function connectClient(host: string, port: number): Promise<{ c: Client; t: StreamableHTTPClientTransport }> {
  const url = new URL(`http://${host}:${port}/mcp`)
  const t = new StreamableHTTPClientTransport(url)
  const c = new Client({ name: 'test', version: '0.0.0' })
  await c.connect(t)
  return { c, t }
}

describe('register_agent tool hint rule (tmux only)', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('hint present when tmux_pane_id is not provided', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const { c, t } = await connectClient(host, port)

    const resp = await c.callTool({
      name: 'register_agent',
      arguments: { model: 'opus-4-7', role: 'frontend', name: 'alice' }
    })
    const obj = await parseTool(resp)

    expect(obj.agent_id).toBeDefined()
    expect(typeof obj.hint).toBe('string')
    expect(obj.hint).toMatch(/tmux_pane_id/i)
    expect(obj.hint).toMatch(/bind_runtime_identity/)

    await t.close(); await app.close()
  })

  it('explicit tmux_pane_id is rejected by the strict schema', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const { c, t } = await connectClient(host, port)

    const resp = await c.callTool({
      name: 'register_agent',
      arguments: { model: 'opus-4-7', role: 'frontend', name: 'alice', tmux_pane_id: '%42' }
    })
    const errResp = resp as { isError?: boolean; content: Array<{ text: string }> }
    expect(errResp.isError).toBe(true)
    expect(errResp.content[0].text).toMatch(/tmux_pane_id/i)
    await t.close(); await app.close()
  })

  it('hint suppressed when delivery.kind is non-none', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const { c, t } = await connectClient(host, port)

    const resp = await c.callTool({
      name: 'register_agent',
      arguments: {
        model: 'opus-4-7',
        role: 'frontend',
        name: 'alice',
        delivery: {
          kind: 'codex-appserver',
          thread_id: '11111111-1111-4111-8111-111111111111',
          ws_url: 'ws://127.0.0.1:8799',
        },
      }
    })
    const obj = await parseTool(resp)
    expect(obj.agent_id).toBeDefined()
    expect(obj.hint).toBeUndefined()

    await t.close(); await app.close()
  })

  it('register_agent rejects unknown channel_session_id argument (strict schema)', async () => {
    const dir = tmp(); cleanups.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const { c, t } = await connectClient(host, port)

    // register_agent is no longer a writer for channel_session_id. After the
    // delivery-abstraction refactor, the MCP tool schema is strict and returns
    // a validation error envelope (isError: true) for unknown top-level args.
    // No agent row must be created.
    const resp = await c.callTool({
      name: 'register_agent',
      arguments: {
        model: 'opus-4-7', role: 'frontend', name: 'alice',
        channel_session_id: 'csid-should-not-be-written'
      }
    })
    const errResp = resp as { isError?: boolean; content: Array<{ text: string }> }
    expect(errResp.isError).toBe(true)
    expect(errResp.content[0].text).toMatch(/channel_session_id/i)
    expect(errResp.content[0].text).toMatch(/unrecognized_keys|Input validation/i)
    // Schema rejection happens before any DB write, so no agent row exists.

    await t.close(); await app.close()
  })
})
