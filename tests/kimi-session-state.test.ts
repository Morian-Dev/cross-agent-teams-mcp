import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  probeKimiSessionState,
  isWireLogRecent,
  createKimiSessionPrecheck,
  TUI_RECENT_WRITE_WINDOW_MS,
} from '../src/mcp/kimi-session-state.js'

const SESSION_ID = 'session_abc'
const BASE_URL = 'http://127.0.0.1:58627'
const HEADERS = { Authorization: 'Bearer t' }

const tmpDirs: string[] = []
afterEach(() => {
  tmpDirs.forEach(d => rmSync(d, { recursive: true, force: true }))
  tmpDirs.length = 0
})

function makeFetch(args: {
  status?: number
  body?: string
  reject?: () => Error
}): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = []
  const fetchMock = (async (url: string) => {
    if (args.reject) throw args.reject()
    calls.push(url)
    const body = args.body ?? ''
    return new Response(body.length > 0 ? body : null, { status: args.status ?? 200 })
  }) as unknown as typeof fetch
  return { fetch: fetchMock, calls }
}

function envelope(data: unknown): string {
  return JSON.stringify({ code: 0, msg: 'ok', data })
}

function makeSessionsRoot(args: {
  sessionId?: string
  ageMs?: number
  create?: boolean
}): string {
  const root = mkdtempSync(join(tmpdir(), 'atm-kimi-sessions-'))
  tmpDirs.push(root)
  if (args.create === false) return root
  const dir = join(root, 'wd_deadbeef', args.sessionId ?? SESSION_ID, 'agents', 'main')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'wire.jsonl')
  writeFileSync(file, '{}\n')
  if (args.ageMs !== undefined) {
    const when = (Date.now() - args.ageMs) / 1000
    utimesSync(file, when, when)
  }
  return root
}

describe('probeKimiSessionState', () => {
  it('returns main_turn_active and pending_interaction from a 2xx envelope', async () => {
    const { fetch: fetchMock, calls } = makeFetch({
      status: 200,
      body: envelope({ busy: true, main_turn_active: true, pending_interaction: 'none' }),
    })
    const signal = await probeKimiSessionState({
      base_url: BASE_URL,
      session_id: SESSION_ID,
      headers: HEADERS,
      fetch: fetchMock,
    })
    expect(signal).toEqual({ main_turn_active: true, pending_interaction: 'none' })
    expect(calls).toEqual([`${BASE_URL}/api/v1/sessions/${SESSION_ID}`])
  })

  it('fails open (no signal) when the fetch rejects', async () => {
    const { fetch: fetchMock } = makeFetch({ reject: () => new Error('ECONNREFUSED') })
    const signal = await probeKimiSessionState({
      base_url: BASE_URL,
      session_id: SESSION_ID,
      headers: HEADERS,
      fetch: fetchMock,
    })
    expect(signal).toEqual({})
  })

  it('fails open (no signal) on a non-2xx response', async () => {
    const { fetch: fetchMock } = makeFetch({
      status: 500,
      body: envelope({ main_turn_active: true }),
    })
    const signal = await probeKimiSessionState({
      base_url: BASE_URL,
      session_id: SESSION_ID,
      headers: HEADERS,
      fetch: fetchMock,
    })
    expect(signal).toEqual({})
  })

  it('fails open (no signal) on a 200 error envelope with a non-zero code', async () => {
    const { fetch: fetchMock } = makeFetch({
      status: 200,
      body: JSON.stringify({
        code: 40401,
        msg: 'session does not exist',
        data: { main_turn_active: true },
      }),
    })
    const signal = await probeKimiSessionState({
      base_url: BASE_URL,
      session_id: SESSION_ID,
      headers: HEADERS,
      fetch: fetchMock,
    })
    expect(signal).toEqual({})
  })

  it('fails open (no signal) when the body omits the fields', async () => {
    const { fetch: fetchMock } = makeFetch({ status: 200, body: envelope({ busy: true }) })
    const signal = await probeKimiSessionState({
      base_url: BASE_URL,
      session_id: SESSION_ID,
      headers: HEADERS,
      fetch: fetchMock,
    })
    expect(signal).toEqual({})
  })

  it('fails open (no signal) when the body is empty or not JSON', async () => {
    for (const body of ['', 'not json']) {
      const { fetch: fetchMock } = makeFetch({ status: 200, body })
      const signal = await probeKimiSessionState({
        base_url: BASE_URL,
        session_id: SESSION_ID,
        headers: HEADERS,
        fetch: fetchMock,
      })
      expect(signal).toEqual({})
    }
  })

  it('sends the bearer headers with the probe GET', async () => {
    const seen: Array<Record<string, string>> = []
    const fetchMock = (async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>)
      return new Response(envelope({ main_turn_active: false }), { status: 200 })
    }) as unknown as typeof fetch
    await probeKimiSessionState({
      base_url: BASE_URL,
      session_id: SESSION_ID,
      headers: HEADERS,
      fetch: fetchMock,
    })
    expect(seen[0]['Authorization']).toBe('Bearer t')
  })
})

describe('isWireLogRecent', () => {
  it('is recent when the wire log was modified inside the window', () => {
    const sessionsRoot = makeSessionsRoot({ ageMs: 2_000 })
    expect(isWireLogRecent({ session_id: SESSION_ID, sessionsRoot })).toBe(true)
  })

  it('is not recent when the wire log was modified outside the window', () => {
    const sessionsRoot = makeSessionsRoot({ ageMs: 10 * 60_000 })
    expect(isWireLogRecent({ session_id: SESSION_ID, sessionsRoot })).toBe(false)
  })

  it('fails open (not recent) when the wire log is missing', () => {
    const sessionsRoot = makeSessionsRoot({ create: false })
    expect(isWireLogRecent({ session_id: SESSION_ID, sessionsRoot })).toBe(false)
  })

  it('fails open (not recent) when the sessions root does not exist', () => {
    expect(
      isWireLogRecent({ session_id: SESSION_ID, sessionsRoot: '/nonexistent/xats/kimi' })
    ).toBe(false)
  })

  it('ignores wire logs belonging to a different session', () => {
    const sessionsRoot = makeSessionsRoot({ sessionId: 'session_other', ageMs: 1_000 })
    expect(isWireLogRecent({ session_id: SESSION_ID, sessionsRoot })).toBe(false)
  })

  it('uses a 10 second window by default', () => {
    expect(TUI_RECENT_WRITE_WINDOW_MS).toBe(10_000)
  })
})

describe('createKimiSessionPrecheck', () => {
  function precheckWith(args: {
    body?: string
    status?: number
    reject?: () => Error
    sessionsRoot: string
  }) {
    const { fetch: fetchMock, calls } = makeFetch(args)
    const precheck = createKimiSessionPrecheck({ sessionsRoot: args.sessionsRoot })
    return {
      calls,
      run: () =>
        precheck({
          base_url: BASE_URL,
          session_id: SESSION_ID,
          headers: HEADERS,
          fetch: fetchMock,
        }),
    }
  }

  it('defers on main_turn_active', async () => {
    const { run } = precheckWith({
      body: envelope({ main_turn_active: true, pending_interaction: 'none' }),
      sessionsRoot: makeSessionsRoot({ ageMs: 10 * 60_000 }),
    })
    expect(await run()).toEqual({ decision: 'defer', reason: 'main_turn_active' })
  })

  it('reports pending_interaction ahead of main_turn_active', async () => {
    const { run } = precheckWith({
      body: envelope({ main_turn_active: true, pending_interaction: 'approval' }),
      sessionsRoot: makeSessionsRoot({ ageMs: 10 * 60_000 }),
    })
    expect(await run()).toEqual({
      decision: 'pending_interaction',
      pending_interaction: 'approval',
    })
  })

  it('proceeds when only busy is true', async () => {
    const { run } = precheckWith({
      body: envelope({ busy: true, main_turn_active: false, pending_interaction: 'none' }),
      sessionsRoot: makeSessionsRoot({ ageMs: 10 * 60_000 }),
    })
    expect(await run()).toEqual({ decision: 'proceed' })
  })

  it('defers on a recent wire-log write', async () => {
    const { run } = precheckWith({
      body: envelope({ main_turn_active: false, pending_interaction: 'none' }),
      sessionsRoot: makeSessionsRoot({ ageMs: 2_000 }),
    })
    expect(await run()).toEqual({ decision: 'defer', reason: 'tui_recent_write' })
  })

  it('proceeds when both probe inputs are unavailable', async () => {
    const { run } = precheckWith({
      reject: () => new Error('ECONNREFUSED'),
      sessionsRoot: makeSessionsRoot({ create: false }),
    })
    expect(await run()).toEqual({ decision: 'proceed' })
  })
})
