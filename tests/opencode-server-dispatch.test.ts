import { describe, it, expect } from 'vitest'
import {
  dispatchOpencodeServerPoke,
  type OpencodeServerDispatchResult,
} from '../src/mcp/opencode-server-dispatch.js'

const SESSION_ID = 'ses_abc'
const BASE_URL = 'http://127.0.0.1:18888'
const DELIVERY = {
  kind: 'opencode-server' as const,
  session_id: SESSION_ID,
  base_url: BASE_URL,
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
  const status = args.status ?? 204
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

describe('dispatchOpencodeServerPoke', () => {
  it('returns ok with transport_used opencode-server on HTTP 204', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 204 })
    const result = await dispatchOpencodeServerPoke(
      { delivery: DELIVERY, content: 'hello from daemon' },
      { fetch: fetchMock, env: {} }
    )
    expect(result).toEqual({
      ok: true,
      transport_used: 'opencode-server',
      session_id: SESSION_ID,
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${BASE_URL}/session/${SESSION_ID}/prompt_async`)
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(calls[0].init.body)).toEqual({
      parts: [{ type: 'text', text: 'hello from daemon' }],
      noReply: false,
    })
  })

  it('omits Authorization header when auth_token_ref is absent', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 204 })
    await dispatchOpencodeServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {} }
    )
    expect(calls[0].init.headers['Authorization']).toBeUndefined()
  })

  it('attaches Authorization: Bearer header when auth_token_ref resolves', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 204 })
    await dispatchOpencodeServerPoke(
      {
        delivery: { ...DELIVERY, auth_token_ref: 'OPENCODE_SERVER_PASSWORD' },
        content: 'hello',
      },
      {
        fetch: fetchMock,
        env: { OPENCODE_SERVER_PASSWORD: 'secret-token' },
      }
    )
    expect(calls[0].init.headers['Authorization']).toBe('Bearer secret-token')
  })

  it('returns missing_auth_token (no network call) when auth_token_ref is unset in env', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 204 })
    const result = await dispatchOpencodeServerPoke(
      {
        delivery: { ...DELIVERY, auth_token_ref: 'OPENCODE_SERVER_PASSWORD' },
        content: 'hello',
      },
      { fetch: fetchMock, env: {} }
    )
    expect(result).toEqual({
      error: 'missing_auth_token',
      detail: { ref: 'OPENCODE_SERVER_PASSWORD' },
    })
    expect(calls).toHaveLength(0)
  })

  it('maps fetch rejection to opencode_connect_failed', async () => {
    const { fetch: fetchMock, calls } = makeFetch({
      reject: () => new Error('ECONNREFUSED'),
    })
    const result = await dispatchOpencodeServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {} }
    )
    expect(result).toEqual({
      error: 'opencode_connect_failed',
      detail: 'ECONNREFUSED',
      transport_used: 'opencode-server',
    })
    expect(calls).toHaveLength(0)
  })

  it('maps 404 response to opencode_inject_failed with status and body', async () => {
    const { fetch: fetchMock } = makeFetch({
      status: 404,
      body: '{"error":"session not found"}',
    })
    const result = await dispatchOpencodeServerPoke(
      { delivery: { ...DELIVERY, session_id: 'ses_ghost' }, content: 'hello' },
      { fetch: fetchMock, env: {} }
    )
    expect(result).toEqual({
      error: 'opencode_inject_failed',
      detail: {
        status: 404,
        body: '{"error":"session not found"}',
      },
      transport_used: 'opencode-server',
    })
  })

  it('maps 500 response to opencode_inject_failed', async () => {
    const { fetch: fetchMock } = makeFetch({
      status: 500,
      body: 'internal error',
    })
    const result = await dispatchOpencodeServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {} }
    )
    expect(result).toEqual({
      error: 'opencode_inject_failed',
      detail: { status: 500, body: 'internal error' },
      transport_used: 'opencode-server',
    })
  })

  it('truncates body to 4KB in inject_failed detail', async () => {
    const bigBody = 'x'.repeat(10_000)
    const { fetch: fetchMock } = makeFetch({
      status: 500,
      body: bigBody,
    })
    const result = await dispatchOpencodeServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {} }
    ) as Extract<OpencodeServerDispatchResult, { error: unknown }> & { detail: { body: string } }
    expect(result.error).toBe('opencode_inject_failed')
    const body = result.detail.body as string
    expect(body.length).toBe(4096)
    expect(bigBody.startsWith(body)).toBe(true)
  })

  it('accepts any 2xx status (not just 204)', async () => {
    const { fetch: fetchMock } = makeFetch({ status: 200, body: '{"accepted":true}' })
    const result = await dispatchOpencodeServerPoke(
      { delivery: DELIVERY, content: 'hello' },
      { fetch: fetchMock, env: {} }
    )
    expect(result).toEqual({
      ok: true,
      transport_used: 'opencode-server',
      session_id: SESSION_ID,
    })
  })

  it('strips trailing slashes from base_url before building the URL', async () => {
    const { fetch: fetchMock, calls } = makeFetch({ status: 204 })
    await dispatchOpencodeServerPoke(
      { delivery: { ...DELIVERY, base_url: 'http://127.0.0.1:18888//' }, content: 'hello' },
      { fetch: fetchMock, env: {} }
    )
    expect(calls[0].url).toBe(`${BASE_URL}/session/${SESSION_ID}/prompt_async`)
  })
})
