import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-sm-zod-'))

interface ToolCallResult {
  content?: Array<{ type: string; text: string }>
  isError?: boolean
}

describe('send_message Zod schema', () => {
  const dirs: string[] = []
  afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs.length = 0 })

  async function client(): Promise<{ c: Client; close: () => Promise<void> }> {
    const dir = tmp(); dirs.push(dir)
    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const t = new StreamableHTTPClientTransport(url)
    const c = new Client({ name: 'test', version: '0' })
    await c.connect(t)
    return { c, close: async () => { await t.close(); await app.close() } }
  }

  function textOf(resp: unknown): string {
    const r = resp as ToolCallResult
    return (r.content ?? []).map(c => c.text).join('\n')
  }

  it('rejects to_role with validation error', async () => {
    const { c, close } = await client()
    const resp = await c.callTool({ name: 'send_message', arguments: { to_agent_id: 'X', to_role: 'frontend', body: 'hi' } }) as ToolCallResult
    expect(resp.isError).toBe(true)
    expect(textOf(resp)).toMatch(/to_role|unknown|unrecognized|validation/i)
    await close()
  })

  it('rejects missing to_agent_id with validation error', async () => {
    const { c, close } = await client()
    const resp = await c.callTool({ name: 'send_message', arguments: { body: 'hi' } }) as ToolCallResult
    expect(resp.isError).toBe(true)
    expect(textOf(resp)).toMatch(/to_agent_id|required|validation/i)
    await close()
  })

  it('accepts to_team as optional string', async () => {
    const { c, close } = await client()
    const resp = await c.callTool({ name: 'send_message', arguments: { to_agent_id: 'fake', to_team: 'beta', body: 'hi' } }) as ToolCallResult
    expect(resp.isError).toBeFalsy()
    expect(textOf(resp)).toMatch(/unknown_agent|unknown_recipient/)
    await close()
  })
})
