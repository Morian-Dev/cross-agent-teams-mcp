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
  const url = `${input.base_url.replace(/\/$/, '')}/v1/sessions/${encodeURIComponent(input.session_id)}/prompt`

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: input.prompt,
        async: true,
      }),
    })
  } catch (cause) {
    return {
      error: 'opencode_unreachable',
      detail: cause instanceof Error ? cause.message : String(cause),
    }
  }

  if (response.ok) {
    return { ok: true }
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    body = await response.text().catch(() => null)
  }

  const detail = body ?? `HTTP ${response.status}`

  if (response.status === 404) {
    return { error: 'opencode_session_not_found', detail }
  }

  if (response.status === 409) {
    return { error: 'opencode_session_busy', detail }
  }

  return { error: 'opencode_request_failed', detail }
}
