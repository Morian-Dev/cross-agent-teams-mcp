import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AgentsRepo } from '../storage/agents-repo.js'
import type { SendMessageService } from './send-message.js'

export type BroadcastResult =
  | { message_id: string; event_id: number; recipients: string[] }
  | { error: 'unknown_recipient' }

export class BroadcastService {
  constructor(
    private db: Database.Database,
    private agents: AgentsRepo,
    private _send: SendMessageService
  ) {}

  broadcast(args: { from: string; body: string; subject?: string }): BroadcastResult {
    const fromRow = this.agents.findById(args.from)
    if (!fromRow) return { error: 'unknown_recipient' }
    const rows = this.db.prepare('SELECT agent_id FROM agents WHERE team=? AND agent_id != ?')
      .all(fromRow.team, args.from) as Array<{ agent_id: string }>
    if (rows.length === 0) return { error: 'unknown_recipient' }
    const recipients = rows.map(r => r.agent_id)
    const baseId = randomUUID()
    const result = this.insertBroadcast(fromRow.team, args.from, recipients, args.body, args.subject, baseId)
    return { ...result, recipients }
  }

  private insertBroadcast(team: string, from: string, recipients: string[], body: string,
                          subject: string | undefined, baseId: string): { message_id: string; event_id: number } {
    const tx = this.db.transaction(() => {
      const event_id = Number(this.db.prepare(
        `INSERT INTO events (team, event_type, actor_agent_id, payload, created_at) VALUES (?,?,?,?,?)`
      ).run(team, 'message_sent', from,
        JSON.stringify({ to_role: '*broadcast*', recipients, subject: subject ?? null }),
        new Date().toISOString()).lastInsertRowid)
      const sent_at = new Date().toISOString()
      const insert = this.db.prepare(
        `INSERT INTO messages (id, event_id, team, from_agent_id, to_agent_id, to_role, subject, body, sent_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      )
      for (let i = 0; i < recipients.length; i++) {
        const id = i === 0 ? baseId : `${baseId}-${i}`
        insert.run(id, event_id, team, from, recipients[i], '*broadcast*', subject ?? null, body, sent_at)
      }
      return { message_id: baseId, event_id }
    })
    return tx()
  }
}
