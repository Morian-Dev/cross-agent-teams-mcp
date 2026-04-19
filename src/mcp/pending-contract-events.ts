import type Database from 'better-sqlite3'
import type { AgentsRepo } from '../storage/agents-repo.js'

export interface ContractEventOut {
  event_id: number
  contract_name: string
  version: number
  diff: unknown | null
  registered_at: string
}

export class PendingContractEventsService {
  constructor(private db: Database.Database, private agents: AgentsRepo) {}

  poll(args: { caller: string; since_event_id?: number; limit?: number }): {
    events: ContractEventOut[]; has_more: boolean; last_event_id: number
  } {
    const caller = this.agents.findById(args.caller)
    if (!caller) return { events: [], has_more: false, last_event_id: args.since_event_id ?? 0 }
    const limit = Math.min(args.limit ?? 100, 500)
    const since = args.since_event_id ?? 0
    const rows = this.db.prepare(
      `SELECT event_id, payload, created_at FROM events
         WHERE to_team=? AND event_type='contract_registered' AND event_id > ?
         ORDER BY event_id ASC LIMIT ?`
    ).all(caller.team, since, limit + 1) as Array<{ event_id: number; payload: string; created_at: string }>
    const has_more = rows.length > limit
    const trimmed = has_more ? rows.slice(0, limit) : rows
    const events = trimmed.map(r => {
      const p = JSON.parse(r.payload) as { name: string; version: number; diff: unknown | null }
      return { event_id: r.event_id, contract_name: p.name, version: p.version, diff: p.diff, registered_at: r.created_at }
    })
    const last_event_id = trimmed.length > 0 ? trimmed[trimmed.length - 1].event_id : since
    return { events, has_more, last_event_id }
  }
}
