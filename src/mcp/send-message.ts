import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AgentsRepo } from '../storage/agents-repo.js'
import type { EventsOutbox } from '../storage/events-outbox.js'
import { fanoutAutoPoke } from './auto-poke-fanout.js'
import type { AutoPokeSkipReason, FanoutDeps } from './auto-poke-fanout.js'
import { RETRY_DELAYS_S } from './poke-retry.js'

export type { AutoPokeFn, AutoPokeSkipReason } from './auto-poke-fanout.js'

export type SendMessageDeps = FanoutDeps

export interface SendInput {
  from: string
  to_agent_id: string
  to_team?: string
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
  retry_scheduled: boolean
  retry_delays_s?: number[]
}

export type SendResult =
  | SuccessResult
  | { error: 'unknown_recipient' }

interface RecipientPokeRow {
  agent_id: string
  tmux_pane_id: string | null
}

interface RecipientLookupRow {
  agent_id: string
  team: string
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
    const fromRow = this.agents.findById(input.from)
    if (!fromRow) return { error: 'unknown_recipient' }
    const fromTeam = fromRow.team
    const toTeam = input.to_team ?? fromTeam

    const rcpt = this.db.prepare('SELECT agent_id, team, tmux_pane_id FROM agents WHERE agent_id=?')
      .get(input.to_agent_id) as RecipientLookupRow | undefined
    if (!rcpt || rcpt.team !== toTeam) return { error: 'unknown_recipient' }
    const recipientRow: RecipientPokeRow = { agent_id: rcpt.agent_id, tmux_pane_id: rcpt.tmux_pane_id }

    const baseResult = this.insert({ fromTeam, toTeam, from: input.from, toAgentId: rcpt.agent_id, input })

    const autoPokeEnabled = input.auto_poke !== false
    if (!autoPokeEnabled) {
      return { ...baseResult, poked: false, retry_scheduled: false }
    }

    const db = this.db
    const fanout = await fanoutAutoPoke({
      team: toTeam,
      fromAgentId: input.from,
      recipients: [recipientRow],
      body: input.body,
      deps: this.deps,
      retry: {
        messageId: baseResult.message_id,
        sentAt: baseResult.sent_at,
        lookupAgentFn: (agentId: string) => {
          return db.prepare('SELECT agent_id, tmux_pane_id, last_seen_at FROM agents WHERE agent_id=?')
            .get(agentId) as { agent_id: string; tmux_pane_id: string | null; last_seen_at: string } | undefined
        }
      }
    })
    const retry_scheduled = fanout.retryScheduledCount > 0
    return {
      message_id: baseResult.message_id,
      event_id: baseResult.event_id,
      recipients: baseResult.recipients,
      poked: fanout.poked,
      poke_skip_reasons: fanout.skipReasons,
      retry_scheduled,
      ...(retry_scheduled ? { retry_delays_s: [...RETRY_DELAYS_S] } : {})
    }
  }

  private insert(args: {
    fromTeam: string; toTeam: string; from: string; toAgentId: string; input: SendInput
  }): { message_id: string; event_id: number; recipients: string[]; sent_at: string } {
    const tx = this.db.transaction(() => {
      const event_id = this.events.append({
        from_team: args.fromTeam, to_team: args.toTeam,
        event_type: 'message_sent', actor_agent_id: args.from,
        payload: { recipients: [args.toAgentId], subject: args.input.subject ?? null }
      })
      const sent_at = new Date().toISOString()
      const id = randomUUID()
      this.db.prepare(
        `INSERT INTO messages (id, event_id, from_team, to_team, from_agent_id, to_agent_id, to_role, subject, body, sent_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(id, event_id, args.fromTeam, args.toTeam, args.from,
        args.toAgentId,
        null, args.input.subject ?? null, args.input.body, sent_at)
      return { message_id: id, event_id, sent_at }
    })
    const { message_id, event_id, sent_at } = tx()
    return { message_id, event_id, recipients: [args.toAgentId], sent_at }
  }
}
