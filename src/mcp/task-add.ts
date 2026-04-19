import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AgentsRepo } from '../storage/agents-repo.js'
import type { EventsOutbox } from '../storage/events-outbox.js'

export type AddResult = { task_id: string } | { error: 'unknown_agent' }

export class TaskAddService {
  constructor(
    private db: Database.Database,
    private agents: AgentsRepo,
    private events: EventsOutbox
  ) {}

  add(args: { caller: string; title: string; description?: string; depends_on?: string[] }): AddResult {
    const caller = this.agents.findById(args.caller)
    if (!caller) return { error: 'unknown_agent' }
    const id = randomUUID()
    const depends_on = JSON.stringify(args.depends_on ?? [])
    const created_at = new Date().toISOString()
    const tx = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO tasks (id, team, title, description, status, depends_on, created_at)
         VALUES (?,?,?,?, 'pending', ?, ?)`
      ).run(id, caller.team, args.title, args.description ?? null, depends_on, created_at)
      this.events.append({
        from_team: caller.team,
        to_team: caller.team,
        event_type: 'task_added',
        actor_agent_id: args.caller,
        payload: { task_id: id, title: args.title }
      })
    })
    tx()
    return { task_id: id }
  }
}
