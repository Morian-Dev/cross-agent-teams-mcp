import type Database from 'better-sqlite3'
import { fanoutAutoPoke, type AutoPokeRecipient, type AutoPokeSkipReason, type FanoutDeps } from './auto-poke-fanout.js'
import { RETRY_DELAYS_S } from './poke-retry.js'

export interface FanoutResultEnvelope {
  poked: boolean
  poke_skip_reasons?: Array<{ agent_id: string; reason: AutoPokeSkipReason }>
  retry_scheduled: boolean
  retry_delays_s?: number[]
}

// Shared fan-out + retry wiring used by both BroadcastService (all-team) and BroadcastToRoleService (same-team role-scoped).
// Same recipient-lookup SQL (agent_id-only, team-agnostic) keeps cross-team retry behaviour consistent.
export async function runFanoutWithRetry(args: {
  db: Database.Database
  team: string
  fromAgentId: string
  recipients: AutoPokeRecipient[]
  body: string
  deps: FanoutDeps
  messageId: string
  sentAt: string
}): Promise<FanoutResultEnvelope> {
  const { db } = args
  const fanout = await fanoutAutoPoke({
    team: args.team,
    fromAgentId: args.fromAgentId,
    recipients: args.recipients,
    body: args.body,
    deps: args.deps,
    retry: {
      messageId: args.messageId,
      sentAt: args.sentAt,
      lookupAgentFn: (agentId: string) => db.prepare(
        'SELECT agent_id, tmux_pane_id, last_seen_at FROM agents WHERE agent_id=?'
      ).get(agentId) as { agent_id: string; tmux_pane_id: string | null; last_seen_at: string } | undefined
    }
  })
  const retry_scheduled = fanout.retryScheduledCount > 0
  return {
    poked: fanout.poked,
    poke_skip_reasons: fanout.skipReasons,
    retry_scheduled,
    ...(retry_scheduled ? { retry_delays_s: [...RETRY_DELAYS_S] } : {})
  }
}
