import type Database from 'better-sqlite3'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { CHANNEL_PROXY_ROLE } from './subscribe-channel-wake.js'

export interface BindInput {
  callerAgentId: string
  channel_session_id: string
}

export type BindResult =
  | { ok: true }
  | { error: 'unknown_agent' | 'forbidden_role' | 'invalid_channel_session_id' | 'unknown_channel_session' }

export class BindChannelService {
  constructor(
    private readonly db: Database.Database,
    private readonly fanout: ChannelWakeFanout
  ) {}

  bind(input: BindInput): BindResult {
    const csid = input.channel_session_id?.trim()
    if (!csid) return { error: 'invalid_channel_session_id' }
    const caller = this.db
      .prepare(`SELECT role FROM agents WHERE agent_id=?`)
      .get(input.callerAgentId) as { role: string } | undefined
    if (!caller) return { error: 'unknown_agent' }
    if (caller.role === CHANNEL_PROXY_ROLE) return { error: 'forbidden_role' }
    if (!this.fanout.has(csid)) return { error: 'unknown_channel_session' }
    this.db
      .prepare(`UPDATE agents SET channel_session_id=? WHERE agent_id=?`)
      .run(csid, input.callerAgentId)
    return { ok: true }
  }
}
