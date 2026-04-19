import type Database from 'better-sqlite3'
import type { AgentsRepo } from '../storage/agents-repo.js'
import type { EventsOutbox } from '../storage/events-outbox.js'

export type CompleteResult =
  | { ok: true }
  | { error: 'not_owner' | 'invalid_status' | 'unknown_task' | 'unknown_agent' }

export class TaskCompleteService {
  constructor(
    private db: Database.Database,
    private agents: AgentsRepo,
    private events: EventsOutbox
  ) {}

  complete(args: { caller: string; task_id: string; result?: string }): CompleteResult {
    const caller = this.agents.findById(args.caller)
    if (!caller) return { error: 'unknown_agent' }
    const row = this.db.prepare(`SELECT status, claimed_by FROM tasks WHERE id=? AND team=?`)
      .get(args.task_id, caller.team) as { status: string; claimed_by: string | null } | undefined
    if (!row) return { error: 'unknown_task' }
    if (row.status !== 'in_progress') return { error: 'invalid_status' }
    if (row.claimed_by !== args.caller) return { error: 'not_owner' }
    const upd = this.db.prepare(
      `UPDATE tasks SET status='completed', completed_at=?, result=?
        WHERE id=? AND team=? AND claimed_by=? AND status='in_progress'`
    ).run(new Date().toISOString(), args.result ?? null, args.task_id, caller.team, args.caller)
    if (upd.changes !== 1) return { error: 'invalid_status' }
    this.events.append({
      from_team: caller.team, to_team: caller.team,
      event_type: 'task_completed', actor_agent_id: args.caller,
      payload: { task_id: args.task_id, result: args.result ?? null }
    })
    return { ok: true }
  }
}
