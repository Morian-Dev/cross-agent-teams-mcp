import type Database from 'better-sqlite3'
import type { AgentsRepo } from '../storage/agents-repo.js'
import { diffSchema, type ContractDiff } from '../lib/schema-diff.js'

export type DiffContractsResult =
  | ContractDiff
  | { error: 'unknown_contract' | 'unknown_version' | 'unknown_agent' }

export class DiffContractsService {
  constructor(private db: Database.Database, private agents: AgentsRepo) {}

  diff(args: { caller: string; name: string; from_version: number; to_version: number }): DiffContractsResult {
    const caller = this.agents.findById(args.caller)
    if (!caller) return { error: 'unknown_agent' }
    const from = this.db.prepare('SELECT schema FROM contracts WHERE team=? AND name=? AND version=?')
      .get(caller.team, args.name, args.from_version) as { schema: string } | undefined
    const to = this.db.prepare('SELECT schema FROM contracts WHERE team=? AND name=? AND version=?')
      .get(caller.team, args.name, args.to_version) as { schema: string } | undefined
    if (!from || !to) {
      const exists = this.db.prepare('SELECT 1 FROM contracts WHERE team=? AND name=? LIMIT 1').get(caller.team, args.name)
      return exists ? { error: 'unknown_version' } : { error: 'unknown_contract' }
    }
    return diffSchema(JSON.parse(from.schema), JSON.parse(to.schema))
  }
}
