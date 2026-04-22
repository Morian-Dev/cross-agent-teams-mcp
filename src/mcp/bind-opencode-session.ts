import type Database from 'better-sqlite3'
import { AgentsRepo } from '../storage/agents-repo.js'

export interface BindOpencodeInput {
  callerAgentId: string
  base_url: string
  session_id: string
}

export type BindOpencodeResult =
  | { ok: true }
  | { error: 'unknown_agent' | 'invalid_opencode_base_url' | 'invalid_opencode_session_id' }

const ALLOWED_LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export class BindOpencodeSessionService {
  private readonly repo: AgentsRepo

  constructor(db: Database.Database) {
    this.repo = new AgentsRepo(db)
  }

  bind(input: BindOpencodeInput): BindOpencodeResult {
    const caller = this.repo.getById(input.callerAgentId)
    if (!caller) return { error: 'unknown_agent' }

    const baseUrl = input.base_url?.trim()
    if (!baseUrl) return { error: 'invalid_opencode_base_url' }

    let parsed: URL
    try {
      parsed = new URL(baseUrl)
    } catch {
      return { error: 'invalid_opencode_base_url' }
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { error: 'invalid_opencode_base_url' }
    }

    if (!ALLOWED_LOOPBACK_HOSTS.has(parsed.hostname)) {
      return { error: 'invalid_opencode_base_url' }
    }

    const sessionId = input.session_id?.trim()
    if (!sessionId) return { error: 'invalid_opencode_session_id' }

    this.repo.setClient(input.callerAgentId, 'opencode')
    this.repo.setOpencodeSession(input.callerAgentId, baseUrl, sessionId)
    return { ok: true }
  }
}
