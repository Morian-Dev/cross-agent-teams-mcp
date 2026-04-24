import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { startServer } from '../src/daemon/server.js'
import { openDb } from '../src/storage/db.js'
import { applySchema } from '../src/storage/schema.js'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'atm-opencode-cli-'))

interface CliResult {
  code: number | null
  stdout: string
  stderr: string
}

function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['--import', 'tsx/esm', 'src/cli.ts', ...args], {
      cwd: process.cwd(),
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('error', reject)
    proc.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('pre-register-opencode-pane CLI', () => {
  const cleanups: string[] = []

  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('writes a pre-reg row to the running daemon', async () => {
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port } = await startServer({ dbPath, port: 0 })

    const result = await runCli([
      'pre-register-opencode-pane',
      '--pane', '%1972',
      '--base-url', 'http://127.0.0.1:4096',
      '--session-id', 'ses_cli_ok',
      '--port', String(port),
    ])

    await app.close()

    expect(result.code).toBe(0)
    const parsed = JSON.parse(result.stdout.trim())
    expect(parsed.ok).toBe(true)
    expect(typeof parsed.expires_at).toBe('string')

    const db = openDb(dbPath)
    applySchema(db)
    const row = db
      .prepare('SELECT pane_id, base_url, session_id FROM opencode_pane_pre_registrations')
      .get() as { pane_id: string; base_url: string; session_id: string }
    db.close()
    expect(row).toEqual({
      pane_id: '%1972',
      base_url: 'http://127.0.0.1:4096',
      session_id: 'ses_cli_ok',
    })
  }, 20_000)

  it('rejects non-loopback base_url with nonzero exit and JSON error on stderr', async () => {
    const dir = tmp()
    cleanups.push(dir)
    const dbPath = join(dir, 'data.db')
    const { app, port } = await startServer({ dbPath, port: 0 })

    const result = await runCli([
      'pre-register-opencode-pane',
      '--pane', '%1973',
      '--base-url', 'http://10.0.0.5:4096',
      '--session-id', 'ses_cli_nok',
      '--port', String(port),
    ])

    await app.close()

    expect(result.code).toBe(1)
    const parsed = JSON.parse(result.stderr.trim().split('\n').pop() as string)
    expect(parsed.error).toBe('invalid_opencode_base_url')
  }, 20_000)
})
