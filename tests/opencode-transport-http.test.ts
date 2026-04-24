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

describe('sendOpencodePrompt response validation', () => {
  it('returns ok only when response is 2xx with application/json', async () => {
    const result = await sendOpencodePrompt(
      { base_url: 'http://127.0.0.1:4096', session_id: 'ses_abc', prompt: 'hi' },
      { fetch: async () => makeResponse(JSON.stringify({ id: 'x' }), { contentType: 'application/json' }) }
    )
    expect(result).toEqual({ ok: true })
  })

  it('rejects 200 HTML responses as opencode_request_failed instead of silently succeeding', async () => {
    const html = '<!doctype html><html><head><title>OpenCode</title></head><body>spa</body></html>'
    const result = await sendOpencodePrompt(
      { base_url: 'http://127.0.0.1:4096', session_id: 'ses_abc', prompt: 'hi' },
      { fetch: async () => makeResponse(html, { contentType: 'text/html; charset=utf-8' }) }
    )
    expect(result).toMatchObject({
      error: 'opencode_request_failed',
      detail: expect.objectContaining({
        reason: 'non_json_success_response',
        http_status: 200,
        content_type: expect.stringContaining('text/html'),
      }),
    })
  })

  it('rejects 200 with missing content-type', async () => {
    const result = await sendOpencodePrompt(
      { base_url: 'http://127.0.0.1:4096', session_id: 'ses_abc', prompt: 'hi' },
      { fetch: async () => makeResponse('OK', {}) }
    )
    expect(result).toMatchObject({
      error: 'opencode_request_failed',
      detail: expect.objectContaining({ reason: 'non_json_success_response' }),
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
