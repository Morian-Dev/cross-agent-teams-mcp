import type Database from 'better-sqlite3'
import type { AgentsRepo } from '../storage/agents-repo.js'

export type SubscribeResult =
  | { ok: true; current_version: number | null }
  | { error: 'unknown_agent' }

export class SubscribeContractService {
  constructor(private db: Database.Database, private agents: AgentsRepo) {}

  subscribe(args: { caller: string; name: string }): SubscribeResult {
    const caller = this.agents.findById(args.caller)
    if (!caller) return { error: 'unknown_agent' }
    this.db.prepare(
      `INSERT INTO contract_subscriptions (agent_id, team, contract_name, subscribed_at)
       VALUES (?,?,?,?)
       ON CONFLICT(agent_id, team, contract_name) DO UPDATE SET subscribed_at=excluded.subscribed_at`
    ).run(args.caller, caller.team, args.name, new Date().toISOString())
    const latest = this.db.prepare(
      'SELECT MAX(version) AS v FROM contracts WHERE team=? AND name=?'
    ).get(caller.team, args.name) as { v: number | null }
    return { ok: true, current_version: latest.v ?? null }
  }
}
