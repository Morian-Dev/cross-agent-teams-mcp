import type { DeliveryKimiServer } from '../lib/delivery-spec.js'
import { describeError } from './codex-appserver-rpc.js'
import { kimiAuthHeaders, DEFAULT_KIMI_TOKEN_FILE } from './kimi-auth.js'

type FetchLike = typeof globalThis.fetch

export interface KimiServerDispatchDeps {
  env?: NodeJS.ProcessEnv
  fetch?: FetchLike
  tokenFilePath?: string
}

export type KimiServerDispatchResult =
  | {
      ok: true
      transport_used: 'kimi-server'
      session_id: string
    }
  | {
      error:
        | 'missing_auth_token'
        | 'kimi_connect_failed'
        | 'kimi_inject_failed'
      detail?: unknown
      transport_used?: 'kimi-server'
    }

const MAX_BODY_PREVIEW_BYTES = 4 * 1024

function truncateBody(body: string): string {
  if (body.length <= MAX_BODY_PREVIEW_BYTES) return body
  return body.slice(0, MAX_BODY_PREVIEW_BYTES)
}

function hasNonZeroErrorCode(bodyText: string): boolean {
  if (bodyText === '') return false
  try {
    const parsed: unknown = JSON.parse(bodyText)
    if (typeof parsed !== 'object' || parsed === null) return false
    const code = (parsed as Record<string, unknown>).code
    return typeof code === 'number' && code !== 0
  } catch {
    return false
  }
}

export async function dispatchKimiServerPoke(
  input: {
    delivery: DeliveryKimiServer
    content: string
  },
  deps: KimiServerDispatchDeps = {}
): Promise<KimiServerDispatchResult> {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetch ?? globalThis.fetch

  const auth = kimiAuthHeaders(
    input.delivery.auth_token_ref,
    env,
    deps.tokenFilePath ?? DEFAULT_KIMI_TOKEN_FILE
  )
  if ('error' in auth) return auth

  const url = `${input.delivery.base_url.replace(/\/+$/, '')}/api/v1/sessions/${encodeURIComponent(input.delivery.session_id)}/prompts`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...auth.headers,
  }
  const body = JSON.stringify({
    content: [{ type: 'text', text: input.content }],
  })

  let response: Response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
    })
  } catch (error) {
    return {
      error: 'kimi_connect_failed',
      detail: describeError(error),
      transport_used: 'kimi-server',
    }
  }

  let bodyText = ''
  try {
    bodyText = await response.text()
  } catch {
    bodyText = ''
  }

  if (!response.ok) {
    return {
      error: 'kimi_inject_failed',
      detail: {
        status: response.status,
        body: truncateBody(bodyText),
      },
      transport_used: 'kimi-server',
    }
  }

  // The kimi server answers application-level failures (e.g. unknown
  // session_id) with HTTP 200 and an error envelope {"code":40401,...}
  // instead of a non-2xx status. Treat a numeric non-zero `code` as an
  // injection failure so dead sessions don't report ok.
  if (hasNonZeroErrorCode(bodyText)) {
    return {
      error: 'kimi_inject_failed',
      detail: {
        status: response.status,
        body: truncateBody(bodyText),
      },
      transport_used: 'kimi-server',
    }
  }

  return {
    ok: true,
    transport_used: 'kimi-server',
    session_id: input.delivery.session_id,
  }
}
