import type Database from 'better-sqlite3'
import type { AgentsRepo } from '../storage/agents-repo.js'

export interface InboxMessage {
  id: string
  event_id: number
  from_agent_id: string
  from_role: string | null
  to_agent_id: string | null
  to_role: string | null
  subject: string | null
  body: string
  sent_at: string
}

export interface InboxResult {
  messages: InboxMessage[]
  has_more: boolean
  last_event_id: number
}

export class GetInboxService {
  constructor(private db: Database.Database, private agents: AgentsRepo) {}

  get(args: { caller: string; since_event_id?: number; limit?: number }): InboxResult {
    const caller = this.agents.findById(args.caller)
    if (!caller) return { messages: [], has_more: false, last_event_id: args.since_event_id ?? 0 }
    const callerTeam = caller.team
    const callerRole = this.db.prepare('SELECT role FROM agents WHERE agent_id=?')
      .get(args.caller) as { role: string } | undefined
    const limit = Math.min(args.limit ?? 50, 200)
    const since = args.since_event_id ?? 0
    const rows = this.db.prepare(
      `SELECT m.id, m.event_id, m.from_agent_id, m.to_agent_id, m.to_role, m.subject, m.body, m.sent_at,
              a.role as from_role
         FROM messages m
         LEFT JOIN agents a ON a.agent_id = m.from_agent_id
        WHERE m.to_team = ?
          AND m.event_id > ?
          AND ( m.to_agent_id = ? OR (m.to_role IS NOT NULL AND m.to_role = ?) )
        ORDER BY m.event_id ASC
        LIMIT ?`
    ).all(callerTeam, since, args.caller, callerRole?.role ?? '__none__', limit + 1) as InboxMessage[]
    const has_more = rows.length > limit
    const trimmed = has_more ? rows.slice(0, limit) : rows
    const last_event_id = trimmed.length > 0 ? trimmed[trimmed.length - 1].event_id : since
    return { messages: trimmed, has_more, last_event_id }
  }
}
