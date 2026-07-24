import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type FetchLike = typeof globalThis.fetch

/** A TUI-side turn appends to wire.jsonl continuously while it executes. */
export const TUI_RECENT_WRITE_WINDOW_MS = 10_000

export const DEFAULT_KIMI_SESSIONS_ROOT = join(homedir(), '.kimi-code', 'sessions')

/** Absent fields mean "the probe could not answer" and MUST fail open. */
export interface KimiSessionSignal {
  main_turn_active?: boolean
  pending_interaction?: string
}

export type KimiPrecheckDecision =
  | { decision: 'proceed' }
  | { decision: 'defer'; reason: 'main_turn_active' | 'tui_recent_write' }
  | { decision: 'pending_interaction'; pending_interaction: string }

export interface KimiPrecheckArgs {
  base_url: string
  session_id: string
  headers: Record<string, string>
  fetch: FetchLike
}

export type KimiPrecheckFn = (args: KimiPrecheckArgs) => Promise<KimiPrecheckDecision>

export function kimiSessionUrl(base_url: string, session_id: string): string {
  return `${base_url.replace(/\/+$/, '')}/api/v1/sessions/${encodeURIComponent(session_id)}`
}

function parseEnvelopeData(bodyText: string): Record<string, unknown> | undefined {
  if (bodyText === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const root = parsed as Record<string, unknown>
  const code = root.code
  if (typeof code === 'number' && code !== 0) return undefined
  const data = root.data
  if (typeof data === 'object' && data !== null) return data as Record<string, unknown>
  return root
}

/**
 * GET the session row. Every failure path resolves to an empty signal so the
 * caller degrades to un-gated injection rather than to a delivery outage.
 */
export async function probeKimiSessionState(
  args: KimiPrecheckArgs
): Promise<KimiSessionSignal> {
  let response: Response
  try {
    response = await args.fetch(kimiSessionUrl(args.base_url, args.session_id), {
      method: 'GET',
      headers: args.headers,
    })
  } catch {
    return {}
  }
  if (!response.ok) return {}

  let bodyText = ''
  try {
    bodyText = await response.text()
  } catch {
    return {}
  }

  const data = parseEnvelopeData(bodyText)
  if (!data) return {}

  const signal: KimiSessionSignal = {}
  if (typeof data.main_turn_active === 'boolean') {
    signal.main_turn_active = data.main_turn_active
  }
  if (typeof data.pending_interaction === 'string') {
    signal.pending_interaction = data.pending_interaction
  }
  return signal
}

function findWireLog(sessionsRoot: string, sessionId: string): string | undefined {
  let entries: string[]
  try {
    entries = readdirSync(sessionsRoot)
  } catch {
    return undefined
  }
  for (const entry of entries) {
    const candidate = join(sessionsRoot, entry, sessionId, 'agents', 'main', 'wire.jsonl')
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      continue
    }
  }
  return undefined
}

/**
 * Heuristic for "a turn is running in the TUI", which the REST probe cannot
 * observe. Only the path is coupled, not the file format. A missing or
 * unreadable log is "no signal" (false), never a deferral.
 */
export function isWireLogRecent(args: {
  session_id: string
  sessionsRoot?: string
  now?: number
  windowMs?: number
}): boolean {
  const root = args.sessionsRoot ?? DEFAULT_KIMI_SESSIONS_ROOT
  const path = findWireLog(root, args.session_id)
  if (!path) return false
  let mtimeMs: number
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    return false
  }
  const now = args.now ?? Date.now()
  const windowMs = args.windowMs ?? TUI_RECENT_WRITE_WINDOW_MS
  return now - mtimeMs < windowMs
}

/**
 * Precondition gate. Precedence: pending_interaction (never retried) →
 * main_turn_active → recent TUI write → proceed. Deliberately gated on
 * main_turn_active and not on `busy`, which also counts background tasks that
 * do not conflict with an injected prompt.
 */
export function createKimiSessionPrecheck(opts: {
  sessionsRoot?: string
  now?: () => number
  windowMs?: number
} = {}): KimiPrecheckFn {
  return async (args) => {
    const signal = await probeKimiSessionState(args)
    if (signal.pending_interaction !== undefined && signal.pending_interaction !== 'none') {
      return {
        decision: 'pending_interaction',
        pending_interaction: signal.pending_interaction,
      }
    }
    if (signal.main_turn_active === true) {
      return { decision: 'defer', reason: 'main_turn_active' }
    }
    const recent = isWireLogRecent({
      session_id: args.session_id,
      sessionsRoot: opts.sessionsRoot,
      now: opts.now?.(),
      windowMs: opts.windowMs,
    })
    if (recent) return { decision: 'defer', reason: 'tui_recent_write' }
    return { decision: 'proceed' }
  }
}
