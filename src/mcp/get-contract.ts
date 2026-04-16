import type Database from 'better-sqlite3'
import type { AgentsRepo } from '../storage/agents-repo.js'

export type GetContractResult =
  | { name: string; version: number; schema: Record<string, unknown>; format: string; note: string | null; registered_at: string }
  | { error: 'unknown_contract' | 'unknown_version' | 'unknown_agent' }

export class GetContractService {
  constructor(private db: Database.Database, private agents: AgentsRepo) {}

  get(args: { caller: string; name: string; version?: number }): GetContractResult {
    const caller = this.agents.findById(args.caller)
    if (!caller) return { error: 'unknown_agent' }
    const row = args.version
      ? this.db.prepare('SELECT * FROM contracts WHERE team=? AND name=? AND version=?').get(caller.team, args.name, args.version)
      : this.db.prepare('SELECT * FROM contracts WHERE team=? AND name=? ORDER BY version DESC LIMIT 1').get(caller.team, args.name)
    if (!row) {
      const exists = this.db.prepare('SELECT 1 FROM contracts WHERE team=? AND name=? LIMIT 1').get(caller.team, args.name)
      return exists ? { error: 'unknown_version' } : { error: 'unknown_contract' }
    }
    const r = row as { name: string; version: number; schema: string; format: string; note: string | null; registered_at: string }
    return { name: r.name, version: r.version, schema: JSON.parse(r.schema), format: r.format, note: r.note, registered_at: r.registered_at }
  }
}
