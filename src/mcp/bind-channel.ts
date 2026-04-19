import type Database from 'better-sqlite3'
import { CHANNEL_PROXY_ROLE } from './subscribe-channel-wake.js'

export interface BindInput {
  callerAgentId: string
  team: string
  name: string
  channel_session_id: string
}

export type BindResult =
  | { ok: true }
  | { error: 'unknown_agent' | 'forbidden_role' | 'invalid_channel_session_id' | 'agent_not_registered' }

export class BindChannelService {
  constructor(private readonly db: Database.Database) {}

  bind(input: BindInput): BindResult {
    const csid = input.channel_session_id?.trim()
    if (!csid) return { error: 'invalid_channel_session_id' }
    const caller = this.db
      .prepare(`SELECT role FROM agents WHERE agent_id=?`)
      .get(input.callerAgentId) as { role: string } | undefined
    if (!caller) return { error: 'unknown_agent' }
    if (caller.role !== CHANNEL_PROXY_ROLE) return { error: 'forbidden_role' }
    const target = this.db
      .prepare(`SELECT agent_id FROM agents WHERE team=? AND name=?`)
      .get(input.team, input.name) as { agent_id: string } | undefined
    if (!target) return { error: 'agent_not_registered' }
    this.db
      .prepare(`UPDATE agents SET channel_session_id=? WHERE team=? AND name=?`)
      .run(csid, input.team, input.name)
    return { ok: true }
  }
}
