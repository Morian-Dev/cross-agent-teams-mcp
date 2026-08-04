import type Database from 'better-sqlite3'
import type { ChannelWakeFanout } from '../daemon/channel-wake-fanout.js'
import { CHANNEL_PROXY_ROLE } from './subscribe-channel-wake.js'

const LIVE_WINDOW_MS = 5 * 60 * 1000

export interface AutoBindInput {
  callerAgentId: string
  ui_pid: number
  device?: string
}

export interface LookupInput {
  ui_pid: number
  device: string
}

export interface AutoBindSuccess {
  ok: true
  channel_session_id: string
}

export interface AutoBindMiss {
  ok: false
  reason: 'no_proxy_row' | 'proxy_payload_corrupt' | 'sink_not_live'
}

export type AutoBindResult = AutoBindSuccess | AutoBindMiss

export interface LookupSuccess {
  ok: true
  channel_session_id: string
}

export interface LookupMiss {
  ok: false
  reason: 'no_proxy_row' | 'proxy_payload_corrupt'
}

export type LookupResult = LookupSuccess | LookupMiss

interface ProxyRow {
  delivery_payload: string | null
}

/**
 * Best-effort: match a live __channel_proxy__ row keyed on claude_ui_pid, and
 * write the caller's delivery to that proxy's csid.  Failure returns `ok:false`
 * with a reason — the caller treats this as "no auto-bind performed" and leaves
 * existing delivery unchanged.
 */
export class AutoBindChannelService {
  constructor(
    private readonly db: Database.Database,
    private readonly fanout: ChannelWakeFanout
  ) {}

  lookup(input: LookupInput): LookupResult {
    return this.findLiveProxyCsid(input)
  }

  run(input: AutoBindInput): AutoBindResult {
    const callerDevice = input.device !== undefined
      ? { device: input.device }
      : this.db.prepare(
          `SELECT device FROM agents WHERE agent_id = ?`
        ).get(input.callerAgentId) as { device: string } | undefined
    const device = callerDevice?.device
    if (!device) return { ok: false, reason: 'no_proxy_row' }
    const found = this.findLiveProxyCsid({ ui_pid: input.ui_pid, device })
    if (!found.ok) return found
    const csid = found.channel_session_id
    if (!this.fanout.has(csid)) return { ok: false, reason: 'sink_not_live' }
    return this.persistDelivery(csid, input.callerAgentId)
  }

  /**
   * Like run() but skips the fanout-liveness check. Used during reverse
   * auto-bind: the channel proxy just registered but hasn't called
   * subscribe_channel_wake yet, so the fanout doesn't have the csid.
   * The delivery row is still correct — the fanout will be populated
   * moments later by subscribe_channel_wake.
   */
  updateDelivery(input: AutoBindInput): AutoBindResult {
    const callerDevice = input.device !== undefined
      ? { device: input.device }
      : this.db.prepare(
          `SELECT device FROM agents WHERE agent_id = ?`
        ).get(input.callerAgentId) as { device: string } | undefined
    const device = callerDevice?.device
    if (!device) return { ok: false, reason: 'no_proxy_row' }
    const found = this.findLiveProxyCsid({ ui_pid: input.ui_pid, device })
    if (!found.ok) return found
    return this.persistDelivery(found.channel_session_id, input.callerAgentId)
  }

  private persistDelivery(csid: string, agentId: string): AutoBindSuccess {
    this.db
      .prepare(
        `UPDATE agents
         SET delivery_kind = 'claude-channel',
             delivery_payload = json_object('channel_session_id', ?)
         WHERE agent_id = ?`
      )
      .run(csid, agentId)
    return { ok: true, channel_session_id: csid }
  }

  private findLiveProxyCsid(input: LookupInput): LookupResult {
    const cutoff = new Date(Date.now() - LIVE_WINDOW_MS).toISOString()
    const row = this.db
      .prepare(
        `SELECT delivery_payload
         FROM agents
         WHERE role = ?
           AND device = ?
           AND claude_ui_pid = ?
           AND last_seen_at > ?
         ORDER BY last_seen_at DESC
         LIMIT 1`
      )
      .get(CHANNEL_PROXY_ROLE, input.device, input.ui_pid, cutoff) as ProxyRow | undefined
    if (!row) return { ok: false, reason: 'no_proxy_row' }
    const csid = extractCsid(row.delivery_payload)
    if (!csid) return { ok: false, reason: 'proxy_payload_corrupt' }
    return { ok: true, channel_session_id: csid }
  }
}

function extractCsid(payload: string | null): string | null {
  if (payload === null) return null
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>
    const csid = parsed.channel_session_id
    if (typeof csid !== 'string' || csid.length === 0) return null
    return csid
  } catch {
    return null
  }
}
