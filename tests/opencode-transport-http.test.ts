import { describe, it, expect } from 'vitest'
import { sendOpencodePrompt } from '../src/mcp/opencode-transport.js'

function makeResponse(
  body: string,
  init: { status?: number; contentType?: string } = {}
): Response {
  const headers = new Headers()
  if (init.contentType !== undefined) headers.set('content-type', init.contentType)
  return new Response(body, { status: init.status ?? 200, headers })
}

describe('sendOpencodePrompt URL and body shape', () => {
  it('targets /session/{id}/prompt_async with parts[{type,text}]', async () => {
    let capturedUrl = ''
    let capturedBody: unknown = null
    await sendOpencodePrompt(
      { base_url: 'http://127.0.0.1:4096', session_id: 'ses_abc', prompt: 'hello world' },
      {
        fetch: async (url, init) => {
          capturedUrl = String(url)
          capturedBody = JSON.parse(String(init?.body ?? '{}'))
          return new Response(null, { status: 204 })
        },
      }
    )
    expect(capturedUrl).toBe('http://127.0.0.1:4096/session/ses_abc/prompt_async')
    expect(capturedBody).toEqual({
      parts: [{ type: 'text', text: 'hello world' }],
    })
  })

  it('strips trailing slash from base_url', async () => {
    let capturedUrl = ''
    await sendOpencodePrompt(
      { base_url: 'http://127.0.0.1:4096/', session_id: 'ses_abc', prompt: 'hi' },
      {
        fetch: async (url) => {
          capturedUrl = String(url)
          return new Response(null, { status: 204 })
        },
      }
    )
    expect(capturedUrl).toBe('http://127.0.0.1:4096/session/ses_abc/prompt_async')
  })

  it('url-encodes session id', async () => {
    let capturedUrl = ''
    await sendOpencodePrompt(
      { base_url: 'http://127.0.0.1:4096', session_id: 'ses/with space', prompt: 'hi' },
      {
        fetch: async (url) => {
          capturedUrl = String(url)
          return new Response(null, { status: 204 })
        },
      }
    )
    expect(capturedUrl).toBe('http://127.0.0.1:4096/session/ses%2Fwith%20space/prompt_async')
  })
})

describe('sendOpencodePrompt response validation', () => {
  it('returns ok on 204 No Content (the documented prompt_async success response)', async () => {
    const result = await sendOpencodePrompt(
      { base_url: 'http://127.0.0.1:4096', session_id: 'ses_abc', prompt: 'hi' },
      { fetch: async () => new Response(null, { status: 204 }) }
    )
    expect(result).toEqual({ ok: true })
  })

  it('rejects 200 HTML responses (SPA fall-through) as opencode_request_failed', async () => {
    const html = '<!doctype html><html><head><title>OpenCode</title></head><body>spa</body></html>'
    const result = await sendOpencodePrompt(
      { base_url: 'http://127.0.0.1:4096', session_id: 'ses_abc', prompt: 'hi' },
      { fetch: async () => makeResponse(html, { status: 200, contentType: 'text/html; charset=utf-8' }) }
    )
    expect(result).toMatchObject({
      error: 'opencode_request_failed',
      detail: expect.objectContaining({
        reason: 'unexpected_success_status',
        http_status: 200,
        content_type: expect.stringContaining('text/html'),
      }),
    })
  })

  it('rejects 200 with application/json success body as unexpected_success_status', async () => {
    const result = await sendOpencodePrompt(
      { base_url: 'http://127.0.0.1:4096', session_id: 'ses_abc', prompt: 'hi' },
      {
        fetch: async () =>
          makeResponse(JSON.stringify({ info: 'anything' }), { status: 200, contentType: 'application/json' }),
      }
    )
    expect(result).toMatchObject({
      error: 'opencode_request_failed',
      detail: expect.objectContaining({ reason: 'unexpected_success_status', http_status: 200 }),
    })
  })

  it('maps 404 to opencode_session_not_found when body is JSON', async () => {
    const result = await sendOpencodePrompt(
      { base_url: 'http://127.0.0.1:4096', session_id: 'ses_missing', prompt: 'hi' },
      {
        fetch: async () =>
          makeResponse(JSON.stringify({ message: 'not found' }), {
            status: 404,
            contentType: 'application/json',
          }),
      }
    )
    expect(result).toMatchObject({ error: 'opencode_session_not_found' })
  })

  it('maps 409 to opencode_session_busy', async () => {
    const result = await sendOpencodePrompt(
      { base_url: 'http://127.0.0.1:4096', session_id: 'ses_busy', prompt: 'hi' },
      {
        fetch: async () =>
          makeResponse(JSON.stringify({ message: 'busy' }), {
            status: 409,
            contentType: 'application/json',
          }),
      }
    )
    expect(result).toMatchObject({ error: 'opencode_session_busy' })
  })

  it('maps 400 to opencode_request_failed', async () => {
    const result = await sendOpencodePrompt(
      { base_url: 'http://127.0.0.1:4096', session_id: 'ses_abc', prompt: 'hi' },
      {
        fetch: async () =>
          makeResponse(JSON.stringify({ error: [{ message: 'bad parts' }] }), {
            status: 400,
            contentType: 'application/json',
          }),
      }
    )
    expect(result).toMatchObject({ error: 'opencode_request_failed' })
  })

  it('returns opencode_unreachable when fetch throws', async () => {
    const result = await sendOpencodePrompt(
      { base_url: 'http://127.0.0.1:4096', session_id: 'ses_abc', prompt: 'hi' },
      {
        fetch: async () => {
          throw new Error('connection refused')
        },
      }
    )
    expect(result).toMatchObject({
      error: 'opencode_unreachable',
      detail: expect.stringContaining('connection refused'),
    })
  })
})
