import { z } from 'zod'
import type { OpencodePanePreRegRepo } from '../storage/opencode-pane-prereg-repo.js'

export const preRegisterOpencodePaneInputSchema = z
  .object({
    pane_id: z
      .string()
      .min(1)
      .refine(v => v.startsWith('%'), {
        message: 'pane_id must be a tmux pane id starting with "%"',
      }),
    base_url: z.string().min(1),
    session_id: z.string().min(1),
    ttl_seconds: z.number().int().positive().optional(),
  })
  .strict()

export type PreRegisterOpencodePaneInput = z.infer<typeof preRegisterOpencodePaneInputSchema>

export type PreRegisterOpencodePaneResult =
  | { ok: true; expires_at: string }
  | { error: 'invalid_arguments'; detail: string }
  | { error: 'invalid_opencode_base_url'; detail: string }
  | { error: 'invalid_opencode_session_id'; detail: string }

const DEFAULT_TTL_SECONDS = 120
const MIN_TTL_SECONDS = 1
const MAX_TTL_SECONDS = 600

const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

function clampTtl(ttl: number | undefined): number {
  const raw = ttl ?? DEFAULT_TTL_SECONDS
  if (raw < MIN_TTL_SECONDS) return MIN_TTL_SECONDS
  if (raw > MAX_TTL_SECONDS) return MAX_TTL_SECONDS
  return raw
}

function validateLoopback(baseUrl: string): { ok: string } | { error: 'invalid_opencode_base_url'; detail: string } {
  const trimmed = baseUrl.trim()
  if (!trimmed) return { error: 'invalid_opencode_base_url', detail: 'base_url must not be empty' }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { error: 'invalid_opencode_base_url', detail: 'base_url must be an absolute URL' }
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { error: 'invalid_opencode_base_url', detail: 'base_url must use http or https' }
  }
  if (!ALLOWED_LOOPBACK_HOSTS.has(parsed.hostname)) {
    return {
      error: 'invalid_opencode_base_url',
      detail: `base_url host must be loopback (one of ${[...ALLOWED_LOOPBACK_HOSTS].join(', ')})`,
    }
  }
  return { ok: trimmed }
}

export class PreRegisterOpencodePaneService {
  constructor(
    private readonly repo: OpencodePanePreRegRepo,
    private readonly now: () => Date = () => new Date()
  ) {}

  register(args: unknown): PreRegisterOpencodePaneResult {
    const parsed = preRegisterOpencodePaneInputSchema.safeParse(args)
    if (!parsed.success) {
      return {
        error: 'invalid_arguments',
        detail: parsed.error.issues
          .map(issue => {
            const path = issue.path.join('.')
            return path ? `${path}: ${issue.message}` : issue.message
          })
          .join('; '),
      }
    }

    const baseUrlCheck = validateLoopback(parsed.data.base_url)
    if ('error' in baseUrlCheck) return baseUrlCheck

    const sessionId = parsed.data.session_id.trim()
    if (!sessionId) {
      return { error: 'invalid_opencode_session_id', detail: 'session_id must not be blank' }
    }

    const now = this.now()
    const ttl = clampTtl(parsed.data.ttl_seconds)
    const expires_at = new Date(now.getTime() + ttl * 1000).toISOString()
    this.repo.purgeExpired(now.toISOString())
    this.repo.put({
      pane_id: parsed.data.pane_id,
      base_url: baseUrlCheck.ok,
      session_id: sessionId,
      expires_at,
    })
    return { ok: true, expires_at }
  }
}
