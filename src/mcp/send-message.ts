import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AgentsRepo } from '../storage/agents-repo.js'
import type { EventsOutbox } from '../storage/events-outbox.js'
import { runQuietGuard } from './poke-guard.js'
import { isTmuxAvailable } from '../daemon/tmux-cli.js'

export type AutoPokeSkipReason = 'no_pane' | 'guard_failed' | 'tmux_unavailable' | 'self'

export interface AutoPokeArgs {
  team: string
  fromAgentId: string
  targetAgentId: string
  paneId: string
  body: string
}

export type AutoPokeFn = (args: AutoPokeArgs) => Promise<{ ok: true } | { ok: false; reason?: AutoPokeSkipReason }>

export interface SendMessageDeps {
  poke?: AutoPokeFn
  tmuxAvailable?: () => Promise<boolean>
}

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

    // Default: auto_poke is true unless explicitly false
    const autoPokeEnabled = input.auto_poke !== false
    if (!autoPokeEnabled) {
      return { ...baseResult, poked: false }
    }

    const fanout = await this.fanoutPoke({
      team,
      fromAgentId: input.from,
      recipients: recipientRows,
      body: input.body
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

  private async fanoutPoke(args: {
    team: string
    fromAgentId: string
    recipients: RecipientPokeRow[]
    body: string
  }): Promise<{ poked: boolean; skipReasons: Array<{ agent_id: string; reason: AutoPokeSkipReason }> }> {
    const pokeFn = this.deps.poke
    const tmuxAvail = this.deps.tmuxAvailable ?? isTmuxAvailable

    const results = await Promise.all(args.recipients.map(async (r): Promise<{
      agent_id: string
      poked: boolean
      reason?: AutoPokeSkipReason
    }> => {
      if (r.agent_id === args.fromAgentId) {
        return { agent_id: r.agent_id, poked: false, reason: 'self' }
      }
      if (!r.tmux_pane_id) {
        return { agent_id: r.agent_id, poked: false, reason: 'no_pane' }
      }
      if (!(await tmuxAvail())) {
        return { agent_id: r.agent_id, poked: false, reason: 'tmux_unavailable' }
      }
      if (!pokeFn) {
        // No poke implementation injected; treat as tmux_unavailable defensively.
        return { agent_id: r.agent_id, poked: false, reason: 'tmux_unavailable' }
      }
      const guard = await runQuietGuard(r.tmux_pane_id)
      if (guard === 'fail') {
        return { agent_id: r.agent_id, poked: false, reason: 'guard_failed' }
      }
      const out = await pokeFn({
        team: args.team,
        fromAgentId: args.fromAgentId,
        targetAgentId: r.agent_id,
        paneId: r.tmux_pane_id,
        body: args.body
      })
      if (out.ok) return { agent_id: r.agent_id, poked: true }
      return { agent_id: r.agent_id, poked: false, reason: out.reason ?? 'guard_failed' }
    }))

    const poked = results.some(x => x.poked)
    const skipReasons = results
      .filter(x => !x.poked && x.reason !== undefined)
      .map(x => ({ agent_id: x.agent_id, reason: x.reason as AutoPokeSkipReason }))
    return { poked, skipReasons }
  }
}
