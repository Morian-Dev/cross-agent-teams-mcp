export interface OpencodeTransportDeps {
  fetch?: typeof fetch
}

export interface OpencodeTransportInput {
  base_url: string
  session_id: string
  prompt: string
}

export type OpencodeTransportResult =
  | { ok: true }
  | { error: 'opencode_unreachable'; detail: string }
  | { error: 'opencode_session_not_found'; detail: string | object }
  | { error: 'opencode_session_busy'; detail: string | object }
  | { error: 'opencode_request_failed'; detail: string | object }

export async function sendOpencodePrompt(
  input: OpencodeTransportInput,
  deps: OpencodeTransportDeps = {}
): Promise<OpencodeTransportResult> {
  const fetchImpl = deps.fetch ?? fetch
  const url = `${input.base_url.replace(/\/$/, '')}/session/${encodeURIComponent(input.session_id)}/prompt_async`

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parts: [{ type: 'text', text: input.prompt }],
      }),
    })
  } catch (cause) {
    return {
      error: 'opencode_unreachable',
      detail: cause instanceof Error ? cause.message : String(cause),
    }
  }

  if (response.status === 204) return { ok: true }

  const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
  let body: unknown
  if (contentType.includes('application/json')) {
    try {
      body = await response.json()
    } catch {
      body = await response.text().catch(() => null)
    }
  } else {
    body = await response.text().catch(() => null)
  }
  const detail = body ?? `HTTP ${response.status}`

  if (response.status === 404) return { error: 'opencode_session_not_found', detail }
  if (response.status === 409) return { error: 'opencode_session_busy', detail }

  if (response.ok) {
    return {
      error: 'opencode_request_failed',
      detail: {
        reason: 'unexpected_success_status',
        http_status: response.status,
        content_type: contentType || 'unknown',
        body_preview: typeof body === 'string' ? body.slice(0, 120) : body,
      },
    }
  }

  return { error: 'opencode_request_failed', detail }
}
