import type Database from 'better-sqlite3'
import type { AgentsRepo } from '../storage/agents-repo.js'
import type { EventsOutbox } from '../storage/events-outbox.js'

export type ClaimResult =
  | { ok: true }
  | { error: 'already_claimed'; owner: string }
  | { error: 'dependencies_pending' }
  | { error: 'unknown_task' }
  | { error: 'unknown_agent' }

export class TaskClaimService {
  constructor(
    private db: Database.Database,
    private agents: AgentsRepo,
    private events: EventsOutbox
  ) {}

  claim(args: { caller: string; task_id: string }): ClaimResult {
    const caller = this.agents.findById(args.caller)
    if (!caller) return { error: 'unknown_agent' }
    const row = this.db.prepare(
      `SELECT status, claimed_by, depends_on FROM tasks WHERE id=? AND team=?`
    ).get(args.task_id, caller.team) as
      { status: string; claimed_by: string | null; depends_on: string } | undefined
    if (!row) return { error: 'unknown_task' }
    if (row.status !== 'pending') {
      if (row.claimed_by) return { error: 'already_claimed', owner: row.claimed_by }
      return { error: 'already_claimed', owner: '' }
    }
    const deps = JSON.parse(row.depends_on) as string[]
    if (deps.length > 0) {
      const pending = this.db.prepare(
        `SELECT COUNT(*) as c FROM tasks WHERE id IN (${deps.map(() => '?').join(',')}) AND team=? AND status != 'completed'`
      ).get(...deps, caller.team) as { c: number }
      if (pending.c > 0) return { error: 'dependencies_pending' }
    }
    const upd = this.db.prepare(
      `UPDATE tasks SET status='in_progress', claimed_by=?, claimed_at=?
        WHERE id=? AND team=? AND status='pending'`
    ).run(args.caller, new Date().toISOString(), args.task_id, caller.team)
    if (upd.changes !== 1) {
      const post = this.db.prepare(`SELECT claimed_by FROM tasks WHERE id=?`).get(args.task_id) as
        { claimed_by: string | null } | undefined
      return { error: 'already_claimed', owner: post?.claimed_by ?? '' }
    }
    this.events.append({
      team: caller.team, event_type: 'task_claimed', actor_agent_id: args.caller,
      payload: { task_id: args.task_id }
    })
    return { ok: true }
  }
}
