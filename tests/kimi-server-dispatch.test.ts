import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dispatchKimiServerPoke,
  type KimiServerDispatchResult,
} from '../src/mcp/kimi-server-dispatch.js'
import { dispatchPoke } from '../src/mcp/transport-dispatch.js'

const SESSION_ID = 'session_abc'
const BASE_URL = 'http://127.0.0.1:58627'
const DELIVERY = {
  kind: 'kimi-server' as const,
  session_id: SESSION_ID,
  base_url: BASE_URL,
}

const tmpDirs: string[] = []
afterEach(() => {
  tmpDirs.forEach(d => rmSync(d, { recursive: true, force: true }))
  tmpDirs.length = 0
})

function makeTokenFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'atm-kimi-token-'))
  tmpDirs.push(dir)
  const path = join(dir, 'server.token')
  writeFileSync(path, content)
  return path
}

function missingTokenFilePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'atm-kimi-token-'))
  tmpDirs.push(dir)
  return join(dir, 'server.token')
}

type FetchCall = {
  url: string
  init: {
    method: string
    headers: Record<string, string>
    body: string
  }
}

function makeFetch(args: {
  status?: number
  body?: string
  reject?: (url: string) => Error
}): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const status = args.status ?? 200
  const fetchMock = (async (url: string, init?: RequestInit) => {
    if (args.reject) throw args.reject(url)
    calls.push({
      url,
      init: {
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: (init?.body ?? '') as string,
      },
    })
    const body = args.body ?? ''
    // undici rejects non-empty body for 204/205/304 — pass null in that case
    const initArgs: ResponseInit = { status }
    return new Response(body.length > 0 ? body : null, initArgs)
  }) as unknown as typeof fetch
  return { fetch: fetchMock, calls }
}

describe('dispatchKimiServerPoke', () => {
  it('returns ok with transport_used kimi-server on HTTP 200 and posts the prompt body', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 200 })
    const tokenFilePath = makeTokenFile('file-token')
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello from daemon' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      ok: true,
      transport_used: 'kimi-server',
      session_id: SESSION_ID,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${BASE_URL}/api/v1/sessions/${SESSION_ID}/prompts`)
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(calls[0].init.body)).toEqual({
      content: [{ type: 'text', text: 'hello from daemon' }],
    })
  })

  it('attaches Authorization: Bearer header when auth_token_ref resolves from env', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 200 })
    await dispatchKimiServerPoke(
      {
        delivery: { ...DELIVERY, auth_token_ref: 'KIMI_SERVER_TOKEN' },
        content: 'hello',
      },
      {
        fetch: fetchMock,
        env: { KIMI_SERVER_TOKEN: 'secret-token' },
      }
    )
    expect(calls[0].init.headers['Authorization']).toBe('Bearer secret-token')
  })

  it('reads the bearer token from the token file when auth_token_ref is absent', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 200 })
    const tokenFilePath = makeTokenFile('file-token\n')
    await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(calls[0].init.headers['Authorization']).toBe('Bearer file-token')
  })

  it('returns missing_auth_token (no network call) when auth_token_ref is unset in env', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 200 })
    const result = await dispatchKimiServerPoke(
      {
        delivery: { ...DELIVERY, auth_token_ref: 'KIMI_SERVER_TOKEN' },
        content: 'hello',
      },
      { fetch: fetchMock, env: {} }
    )
    expect(result).toEqual({
      error: 'missing_auth_token',
      detail: { ref: 'KIMI_SERVER_TOKEN' },
    })
    expect(calls).toHaveLength(0)
  })

  it('returns missing_auth_token (no network call) when auth_token_ref resolves to an empty value', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 200 })
    const result = await dispatchKimiServerPoke(
      {
        delivery: { ...DELIVERY, auth_token_ref: 'KIMI_SERVER_TOKEN' },
        content: 'hello',
      },
      { fetch: fetchMock, env: { KIMI_SERVER_TOKEN: '   ' } }
    )
    expect(result).toEqual({
      error: 'missing_auth_token',
      detail: { ref: 'KIMI_SERVER_TOKEN' },
    })
    expect(calls).toHaveLength(0)
  })

  it('returns missing_auth_token (no network call) when the token file is absent', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 200 })
    const tokenFilePath = missingTokenFilePath()
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      error: 'missing_auth_token',
      detail: { token_file: tokenFilePath },
    })
    expect(calls).toHaveLength(0)
  })

  it('returns missing_auth_token (no network call) when the token file is empty', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 200 })
    const tokenFilePath = makeTokenFile('  \n')
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      error: 'missing_auth_token',
      detail: { token_file: tokenFilePath },
    })
    expect(calls).toHaveLength(0)
  })

  it('maps fetch rejection to kimi_connect_failed', async () => {
    const { fetch: fetchMock, calls } = makeFetch({
      reject: () => new Error('ECONNREFUSED'),
    })
    const tokenFilePath = makeTokenFile('file-token')
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      error: 'kimi_connect_failed',
      detail: 'ECONNREFUSED',
      transport_used: 'kimi-server',
    })
    expect(calls).toHaveLength(0)
  })

  it('maps 404 response to kimi_inject_failed with status and body', async () => {
    const { fetch: fetchMock } = makeFetch({
      status: 404,
      body: '{"error":"session not found"}',
    })
    const tokenFilePath = makeTokenFile('file-token')
    const result = await dispatchKimiServerPoke(
      { delivery: { ...DELIVERY, session_id: 'session_ghost' }, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      error: 'kimi_inject_failed',
      detail: {
        status: 404,
        body: '{"error":"session not found"}',
      },
      transport_used: 'kimi-server',
    })
  })

  it('maps 200 with a non-zero code error envelope (real kimi server behavior for unknown session) to kimi_inject_failed', async () => {
    const body = JSON.stringify({
      code: 40401,
      msg: 'session session_ghost does not exist',
      data: null,
    })
    const { fetch: fetchMock } = makeFetch({ status: 200, body })
    const tokenFilePath = makeTokenFile('file-token')
    const result = await dispatchKimiServerPoke(
      { delivery: { ...DELIVERY, session_id: 'session_ghost' }, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      error: 'kimi_inject_failed',
      detail: { status: 200, body },
      transport_used: 'kimi-server',
    })
  })

  it('returns ok for a 200 success envelope with code 0', async () => {
    const { fetch: fetchMock } = makeFetch({
      status: 200,
      body: '{"code":0,"msg":"ok","data":{"prompt_id":"p1"}}',
    })
    const tokenFilePath = makeTokenFile('file-token')
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      ok: true,
      transport_used: 'kimi-server',
      session_id: SESSION_ID,
    })
  })

  it('maps 500 response to kimi_inject_failed', async () => {
    const { fetch: fetchMock } = makeFetch({
      status: 500,
      body: 'internal error',
    })
    const tokenFilePath = makeTokenFile('file-token')
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      error: 'kimi_inject_failed',
      detail: { status: 500, body: 'internal error' },
      transport_used: 'kimi-server',
    })
  })

  it('truncates body to 4KB in inject_failed detail', async () => {
    const bigBody = 'x'.repeat(10_000)
    const { fetch: fetchMock } = makeFetch({
      status: 500,
      body: bigBody,
    })
    const tokenFilePath = makeTokenFile('file-token')
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    ) as Extract<KimiServerDispatchResult, { error: unknown }> & { detail: { body: string } }
    expect(result.error).toBe('kimi_inject_failed')
    const body = result.detail.body as string
    expect(body.length).toBe(4096)
    expect(bigBody.startsWith(body)).toBe(true)
  })

  it('accepts any 2xx status (not just 200)', async () => {
    const { fetch: fetchMock } = makeFetch({ status: 202, body: '{"accepted":true}' })
    const tokenFilePath = makeTokenFile('file-token')
    const result = await dispatchKimiServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(result).toEqual({
      ok: true,
      transport_used: 'kimi-server',
      session_id: SESSION_ID,
    })
  })

  it('strips trailing slashes from base_url before building the URL', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 200 })
    const tokenFilePath = makeTokenFile('file-token')
    await dispatchKimiServerPoke(
      { delivery: { ...DELIVERY, base_url: 'http://127.0.0.1:58627//' }, content: 'hello' },
      { fetch: fetchMock, env: {}, tokenFilePath }
    )
    expect(calls[0].url).toBe(`${BASE_URL}/api/v1/sessions/${SESSION_ID}/prompts`)
  })
})

describe('dispatchPoke kimi-server routing', () => {
  it('routes kimi-server delivery to the kimi dispatcher', async () => {
    const tmuxCalls: unknown[] = []
    const kimiCalls: Array<{ session_id: string; base_url: string; content: string }> = []
    const res = await dispatchPoke(
      {
        tmuxPoke: async args => {
          tmuxCalls.push(args)
          return { ok: true, pane_tail_before: '', pane_tail_after: '' }
        },
        kimiServerDispatch: async ({ delivery, content }) => {
          kimiCalls.push({
            session_id: delivery.session_id,
            base_url: delivery.base_url,
            content,
          })
          return {
            ok: true,
            transport_used: 'kimi-server',
            session_id: delivery.session_id,
          }
        },
      },
      {
        agent_type: 'kimi-code',
        delivery: {
          kind: 'kimi-server',
          session_id: 'session_abc',
          base_url: 'http://127.0.0.1:58627',
        },
        tmux_pane_id: null,
      },
      { content: 'hi', meta: {} }
    )
    expect(res).toEqual({
      ok: true,
      transport_used: 'kimi-server',
      session_id: 'session_abc',
    })
    expect(kimiCalls).toEqual([
      {
        session_id: 'session_abc',
        base_url: 'http://127.0.0.1:58627',
        content: 'hi',
      },
    ])
    expect(tmuxCalls).toHaveLength(0)
  })

  it('does NOT fall back to tmux when kimi-server dispatcher fails (even with tmux_pane_id set)', async () => {
    const tmuxCalls: unknown[] = []
    const res = await dispatchPoke(
      {
        tmuxPoke: async args => {
          tmuxCalls.push(args)
          return { ok: true, pane_tail_before: '', pane_tail_after: '' }
        },
        kimiServerDispatch: async () => ({
          error: 'kimi_connect_failed',
          detail: 'ECONNREFUSED',
          transport_used: 'kimi-server',
        }),
      },
      {
        agent_type: 'kimi-code',
        delivery: {
          kind: 'kimi-server',
          session_id: 'session_abc',
          base_url: 'http://127.0.0.1:58627',
        },
        tmux_pane_id: '%42',
      },
      { content: 'hi', meta: {} }
    )
    expect(res).toEqual({
      error: 'kimi_connect_failed',
      detail: 'ECONNREFUSED',
      transport_used: 'kimi-server',
    })
    expect(tmuxCalls).toHaveLength(0)
  })

  it('routes kimi-server delivery to the kimi dispatcher even when agent_type is null', async () => {
    const kimiCalls: unknown[] = []
    const res = await dispatchPoke(
      {
        tmuxPoke: async () => ({ ok: true, pane_tail_before: '', pane_tail_after: '' }),
        kimiServerDispatch: async ({ delivery }) => {
          kimiCalls.push(delivery)
          return {
            ok: true,
            transport_used: 'kimi-server',
            session_id: delivery.session_id,
          }
        },
      },
      {
        agent_type: null,
        delivery: {
          kind: 'kimi-server',
          session_id: 'session_abc',
          base_url: 'http://127.0.0.1:58627',
        },
        tmux_pane_id: null,
      },
      { content: 'hi', meta: {} }
    )
    expect(res).toMatchObject({ ok: true, transport_used: 'kimi-server' })
    expect(kimiCalls).toHaveLength(1)
  })
})
