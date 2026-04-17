import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { startServer } from '../src/daemon/server.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-mcp-pane-'))

describe('register_agent tmux_pane_id integration', () => {
  const cleanups: string[] = []
  afterEach(() => { cleanups.forEach(d => rmSync(d, { recursive: true, force: true })); cleanups.length = 0 })

  it('accepts tmux_pane_id and persists + exposes it', async () => {
    const dir = tmp(); cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port, host } = await startServer({ dbPath, port: 0 })
    const url = new URL(`http://${host}:${port}/mcp`)
    const transport = new StreamableHTTPClientTransport(url)
    const client = new Client({ name: 'test', version: '0.0.0' })
    await client.connect(transport)

    const regResp = await client.callTool({
      name: 'register_agent',
      arguments: { model: 'opus-4-7', role: 'frontend', tmux_pane_id: '%42', team: 'default' }
    })
    const regText = (regResp.content as Array<{ text: string }>)[0].text
    const reg = JSON.parse(regText) as { agent_id?: string; error?: string }
    expect(reg.agent_id).toBeDefined()

    const listResp = await client.callTool({ name: 'list_agents', arguments: {} })
    const list = JSON.parse((listResp.content as Array<{ text: string }>)[0].text) as { agents: Array<{ agent_id: string; tmux_pane_id: string | null }> }
    expect(list.agents.find(a => a.agent_id === reg.agent_id)?.tmux_pane_id).toBe('%42')

    const db = openDb(dbPath); applySchema(db)
    const row = db.prepare(`SELECT tmux_pane_id FROM agents WHERE agent_id=?`).get(reg.agent_id) as { tmux_pane_id: string }
    expect(row.tmux_pane_id).toBe('%42')
    db.close()

    await transport.terminateSession()
    await client.close()
    await app.close()
  })
})
