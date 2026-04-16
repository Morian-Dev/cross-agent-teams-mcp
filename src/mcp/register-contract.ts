import type Database from 'better-sqlite3'
import type { AgentsRepo } from '../storage/agents-repo.js'
import type { EventsOutbox } from '../storage/events-outbox.js'
import { diffSchema, type ContractDiff } from '../lib/schema-diff.js'

export interface RegisterContractMeta {
  team: string
  event_id: number
  diff: ContractDiff | null
}

export type RegisterContractResult =
  | { name: string; version: number; diff?: ContractDiff; _meta?: RegisterContractMeta }
  | { error: 'unknown_agent' | 'invalid_format' }

export class RegisterContractService {
  constructor(
    private db: Database.Database,
    private agents: AgentsRepo,
    private events: EventsOutbox
  ) {}

  register(args: {
    caller: string; name: string; schema: Record<string, unknown>;
    format?: 'jsonschema'; note?: string
  }): RegisterContractResult {
    const caller = this.agents.findById(args.caller)
    if (!caller) return { error: 'unknown_agent' }
    const format = args.format ?? 'jsonschema'
    if (format !== 'jsonschema') return { error: 'invalid_format' }

    // better-sqlite3's .transaction() wraps BEGIN DEFERRED by default. We need IMMEDIATE
    // so multiple writers serialize cleanly. Use a raw BEGIN IMMEDIATE.
    const txFn = this.db.transaction((): RegisterContractResult => {
      const prev = this.db.prepare(
        `SELECT schema, version FROM contracts WHERE team=? AND name=? ORDER BY version DESC LIMIT 1`
      ).get(caller.team, args.name) as { schema: string; version: number } | undefined
      const version = prev ? prev.version + 1 : 1
      const now = new Date().toISOString()
      this.db.prepare(
        `INSERT INTO contracts (team, name, version, format, schema, note, registered_by, registered_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(caller.team, args.name, version, format, JSON.stringify(args.schema), args.note ?? null, args.caller, now)
      let diff: ContractDiff | undefined
      if (prev) diff = diffSchema(JSON.parse(prev.schema), args.schema as any)
      const event_id = this.events.append({
        team: caller.team,
        event_type: 'contract_registered',
        actor_agent_id: args.caller,
        payload: { name: args.name, version, diff: diff ?? null }
      })
      const meta: RegisterContractMeta = { team: caller.team, event_id, diff: diff ?? null }
      return prev
        ? { name: args.name, version, diff: diff!, _meta: meta }
        : { name: args.name, version, _meta: meta }
    })
    return txFn.immediate()
  }
}
