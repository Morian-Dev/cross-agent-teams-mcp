import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AgentsRepo } from '../storage/agents-repo.js'
import type { EventsOutbox } from '../storage/events-outbox.js'
import { fanoutAutoPoke } from './auto-poke-fanout.js'
import type { AutoPokeSkipReason, FanoutDeps } from './auto-poke-fanout.js'

export type { AutoPokeFn, AutoPokeSkipReason } from './auto-poke-fanout.js'

export type SendMessageDeps = FanoutDeps

export interface SendInput {
  from: string
  to_agent_id?: string
  to_role?: string
  subject?: string
  body: string
  auto_poke?: boolean
}

interface SuccessResult {
  message_id: string
  event_id: number
  recipients: string[]
  poked: boolean
  poke_skip_reasons?: Array<{ agent_id: string; reason: AutoPokeSkipReason }>
}

export type SendResult =
  | SuccessResult
  | { error: 'ambiguous_recipient' | 'missing_recipient' | 'unknown_recipient' }

interface RecipientPokeRow {
  agent_id: string
  tmux_pane_id: string | null
}

export class SendMessageService {
  constructor(
    private db: Database.Database,
    private agents: AgentsRepo,
    private events: EventsOutbox,
    private deps: SendMessageDeps = {}
  ) {}

  async send(input: SendInput): Promise<SendResult> {
    if (input.to_agent_id && input.to_role) return { error: 'ambiguous_recipient' }
    if (!input.to_agent_id && !input.to_role) return { error: 'missing_recipient' }
    const fromRow = this.agents.findById(input.from)
    if (!fromRow) return { error: 'unknown_recipient' }
    const team = fromRow.team

    let recipientRows: RecipientPokeRow[]
    let to_role: string | null
    if (input.to_agent_id) {
      const rcpt = this.db.prepare('SELECT agent_id, tmux_pane_id FROM agents WHERE agent_id=? AND team=?')
        .get(input.to_agent_id, team) as RecipientPokeRow | undefined
      if (!rcpt) return { error: 'unknown_recipient' }
      recipientRows = [rcpt]
      to_role = null
    } else {
      const rows = this.db.prepare('SELECT agent_id, tmux_pane_id FROM agents WHERE role=? AND team=?')
        .all(input.to_role!, team) as RecipientPokeRow[]
      if (rows.length === 0) return { error: 'unknown_recipient' }
      recipientRows = rows
      to_role = input.to_role!
    }

    const recipients = recipientRows.map(r => r.agent_id)
    const baseResult = this.insert({ team, from: input.from, recipients, to_role, input })

    const autoPokeEnabled = input.auto_poke !== false
    if (!autoPokeEnabled) {
      return { ...baseResult, poked: false }
    }

    const fanout = await fanoutAutoPoke({
      team,
      fromAgentId: input.from,
      recipients: recipientRows,
      body: input.body,
      deps: this.deps
    })
    return { ...baseResult, poked: fanout.poked, poke_skip_reasons: fanout.skipReasons }
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
