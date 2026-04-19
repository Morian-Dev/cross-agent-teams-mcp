import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCsid } from '../src/csid-store.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'atm-csid-'))

describe('resolveCsid', () => {
  const cleanups: string[] = []
  afterEach(() => {
    cleanups.forEach(d => rmSync(d, { recursive: true, force: true }))
    cleanups.length = 0
  })

  it('recovers an existing csid from the persistence file', () => {
    const dir = tmp(); cleanups.push(dir)
    const nested = join(dir, 'ts-agent-teams-channel')
    mkdirSync(nested, { recursive: true })
    writeFileSync(
      join(nested, 'default-alice.json'),
      JSON.stringify({ channel_session_id: 'csid-persisted' })
    )
    const csid = resolveCsid({ cacheDir: dir, team: 'default', name: 'alice' })
    expect(csid).toBe('csid-persisted')
  })

  it('generates a new UUID v4 and writes the file when absent', () => {
    const dir = tmp(); cleanups.push(dir)
    const csid = resolveCsid({ cacheDir: dir, team: 'default', name: 'alice' })
    expect(typeof csid).toBe('string')
    expect(csid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    const filePath = join(dir, 'ts-agent-teams-channel', 'default-alice.json')
    expect(existsSync(filePath)).toBe(true)
    const written = JSON.parse(readFileSync(filePath, 'utf8'))
    expect(written.channel_session_id).toBe(csid)
  })

  it('re-invoking for the same identity yields the same csid', () => {
    const dir = tmp(); cleanups.push(dir)
    const first = resolveCsid({ cacheDir: dir, team: 'default', name: 'alice' })
    const second = resolveCsid({ cacheDir: dir, team: 'default', name: 'alice' })
    expect(second).toBe(first)
  })

  it('different identities in the same cacheDir stay isolated', () => {
    const dir = tmp(); cleanups.push(dir)
    const alice = resolveCsid({ cacheDir: dir, team: 'default', name: 'alice' })
    const bob = resolveCsid({ cacheDir: dir, team: 'default', name: 'bob' })
    expect(alice).not.toBe(bob)
  })

  it('regenerates a csid when the persistence file is malformed', () => {
    const dir = tmp(); cleanups.push(dir)
    const nested = join(dir, 'ts-agent-teams-channel')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'default-alice.json'), 'not-json')
    const csid = resolveCsid({ cacheDir: dir, team: 'default', name: 'alice' })
    expect(csid).toMatch(/^[0-9a-f]{8}-/)
  })
})
