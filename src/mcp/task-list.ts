import type Database from 'better-sqlite3'
import type { AgentsRepo } from '../storage/agents-repo.js'

export interface TaskRow {
  id: string
  team: string
  title: string
  description: string | null
  status: 'pending' | 'in_progress' | 'completed'
  depends_on: string[]
  claimed_by: string | null
  claimed_at: string | null
  completed_at: string | null
  result: string | null
  created_at: string
}

export class TaskListService {
  constructor(private db: Database.Database, private agents: AgentsRepo) {}

  list(args: { caller: string; status?: 'pending' | 'in_progress' | 'completed' }): { tasks: TaskRow[] } {
    const caller = this.agents.findById(args.caller)
    if (!caller) return { tasks: [] }
    const sql = args.status
      ? `SELECT * FROM tasks WHERE team=? AND status=? ORDER BY created_at ASC`
      : `SELECT * FROM tasks WHERE team=? ORDER BY created_at ASC`
    const rows = (args.status
      ? this.db.prepare(sql).all(caller.team, args.status)
      : this.db.prepare(sql).all(caller.team)) as Array<TaskRow & { depends_on: string }>
    const tasks = rows.map(r => ({ ...r, depends_on: JSON.parse(r.depends_on as unknown as string) as string[] }))
    return { tasks }
  }
}
