import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AgentsRepo } from '../storage/agents-repo.js'
import type { EventsOutbox } from '../storage/events-outbox.js'

export interface SendInput {
  from: string
  to_agent_id?: string
  to_role?: string
  subject?: string
  body: string
}

export type SendResult =
  | { message_id: string; event_id: number; recipients: string[] }
  | { error: 'ambiguous_recipient' | 'missing_recipient' | 'unknown_recipient' }

export class SendMessageService {
  constructor(
    private db: Database.Database,
    private agents: AgentsRepo,
    private events: EventsOutbox
  ) {}

  send(input: SendInput): SendResult {
    if (input.to_agent_id && input.to_role) return { error: 'ambiguous_recipient' }
    if (!input.to_agent_id && !input.to_role) return { error: 'missing_recipient' }
    const fromRow = this.agents.findById(input.from)
    if (!fromRow) return { error: 'unknown_recipient' }
    const team = fromRow.team

    if (input.to_agent_id) {
      const rcpt = this.db.prepare('SELECT agent_id FROM agents WHERE agent_id=? AND team=?')
        .get(input.to_agent_id, team) as { agent_id: string } | undefined
      if (!rcpt) return { error: 'unknown_recipient' }
      return this.insert({ team, from: input.from, recipients: [rcpt.agent_id], to_role: null, input })
    }

    const rows = this.db.prepare('SELECT agent_id FROM agents WHERE role=? AND team=?')
      .all(input.to_role!, team) as Array<{ agent_id: string }>
    if (rows.length === 0) return { error: 'unknown_recipient' }
    return this.insert({ team, from: input.from, recipients: rows.map(r => r.agent_id), to_role: input.to_role!, input })
  }

  private insert(args: {
    team: string; from: string; recipients: string[]; to_role: string | null; input: SendInput
  }): { message_id: string; event_id: number; recipients: string[] } {
    const tx = this.db.transaction(() => {
      const event_id = this.events.append({
        team: args.team, event_type: 'message_sent', actor_agent_id: args.from,
        payload: { to_role: args.to_role, recipients: args.recipients, subject: args.input.subject ?? null }
      })
      const sent_at = new Date().toISOString()
      const baseId = randomUUID()
      const insert = this.db.prepare(
        `INSERT INTO messages (id, event_id, team, from_agent_id, to_agent_id, to_role, subject, body, sent_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      for (let i = 0; i < args.recipients.length; i++) {
        const id = i === 0 ? baseId : `${baseId}-${i}`
        insert.run(id, event_id, args.team, args.from,
          args.recipients[i],
          args.to_role, args.input.subject ?? null, args.input.body, sent_at)
      }
      return { message_id: baseId, event_id }
    })
    const { message_id, event_id } = tx()
    return { message_id, event_id, recipients: args.recipients }
  }
}
