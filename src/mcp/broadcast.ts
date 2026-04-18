import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AgentsRepo } from '../storage/agents-repo.js'
import type { SendMessageService } from './send-message.js'
import { fanoutAutoPoke } from './auto-poke-fanout.js'
import type { AutoPokeSkipReason, FanoutDeps } from './auto-poke-fanout.js'
import { RETRY_DELAYS_S } from './poke-retry.js'

export type BroadcastDeps = FanoutDeps

export interface BroadcastInput {
  from: string
  body: string
  subject?: string
  auto_poke?: boolean
}

interface SuccessResult {
  message_id: string
  event_id: number
  recipients: string[]
  poked: boolean
  poke_skip_reasons?: Array<{ agent_id: string; reason: AutoPokeSkipReason }>
  retry_scheduled: boolean
  retry_delays_s?: number[]
}

export type BroadcastResult = SuccessResult | { error: 'unknown_recipient' }

interface RecipientPokeRow {
  agent_id: string
  tmux_pane_id: string | null
}

export class BroadcastService {
  constructor(
    private db: Database.Database,
    private agents: AgentsRepo,
    private _send: SendMessageService,
    private deps: BroadcastDeps = {}
  ) {}

  async broadcast(input: BroadcastInput): Promise<BroadcastResult> {
    const fromRow = this.agents.findById(input.from)
    if (!fromRow) return { error: 'unknown_recipient' }
    const rows = this.db.prepare('SELECT agent_id, tmux_pane_id FROM agents WHERE team=? AND agent_id != ?')
      .all(fromRow.team, input.from) as RecipientPokeRow[]
    if (rows.length === 0) return { error: 'unknown_recipient' }
    const recipients = rows.map(r => r.agent_id)
    const baseId = randomUUID()
    const inserted = this.insertBroadcast(fromRow.team, input.from, recipients, input.body, input.subject, baseId)

    if (input.auto_poke !== true) {
      return { ...inserted, recipients, poked: false, retry_scheduled: false }
    }

    const db = this.db
    const fanout = await fanoutAutoPoke({
      team: fromRow.team,
      fromAgentId: input.from,
      recipients: rows,
      body: input.body,
      deps: this.deps,
      retry: {
        messageId: inserted.message_id,
        sentAt: inserted.sent_at,
        lookupAgentFn: (agentId: string) => {
          return db.prepare('SELECT agent_id, tmux_pane_id, last_seen_at FROM agents WHERE agent_id=?')
            .get(agentId) as { agent_id: string; tmux_pane_id: string | null; last_seen_at: string } | undefined
        }
      }
    })
    const retry_scheduled = fanout.retryScheduledCount > 0
    return {
      message_id: inserted.message_id,
      event_id: inserted.event_id,
      recipients,
      poked: fanout.poked,
      poke_skip_reasons: fanout.skipReasons,
      retry_scheduled,
      ...(retry_scheduled ? { retry_delays_s: [...RETRY_DELAYS_S] } : {})
    }
  }

  private insertBroadcast(team: string, from: string, recipients: string[], body: string,
                          subject: string | undefined, baseId: string): { message_id: string; event_id: number; sent_at: string } {
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
      return { message_id: baseId, event_id, sent_at }
    })
    return tx()
  }
}
