import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-register-tool-schema-'))

describe('register_agent tool schema', () => {
  const cleanups: string[] = []

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('exposes register_agent arguments in tools/list', async () => {
    const dir = tmp()
    cleanups.push(dir)

    const { app, port, host } = await startServer({ dbPath: join(dir, 'data.db'), port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const transport = new StreamableHTTPClientTransport(url)
    const client = new Client({ name: 'schema-check', version: '0.0.0' })
    await client.connect(transport)

    const resp = await client.listTools()
    const tool = resp.tools.find(x => x.name === 'register_agent')

    expect(tool).toBeDefined()
    expect(tool!.inputSchema).toMatchObject({
      type: 'object',
      properties: expect.objectContaining({
        model: expect.anything(),
        name: expect.anything(),
        role: expect.anything(),
        team: expect.anything(),
        project_dir: expect.anything(),
        client: expect.anything(),
        client_name: expect.anything(),
        ui_pid: expect.anything(),
        channel_session_id: expect.anything(),
        base_url: expect.anything(),
        session_id: expect.anything(),
        thread_id: expect.anything(),
        ws_url: expect.anything(),
        auth_token_ref: expect.anything(),
        delivery: expect.anything(),
      }),
      required: expect.arrayContaining(['client', 'model', 'name']),
      additionalProperties: false,
    })

    await transport.terminateSession()
    await client.close()
    await app.close()
  })
})
