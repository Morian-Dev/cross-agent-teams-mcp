import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'

export interface RegisterInput {
  model: string
  name: string
  role?: string
  team?: string
  tmux_pane_id?: string
}

export interface AgentListRow {
  agent_id: string
  role: string
  name: string
  model: string | null
  tmux_pane_id: string | null
  last_seen_at: string
  online: boolean
}

export const ONLINE_MS = 5 * 60 * 1000

export class AgentsRepo {
  constructor(private db: Database.Database) {}

  findByIdentity(args: { team: string; name: string; role: string }): { agent_id: string } | undefined {
    return this.db.prepare(
      `SELECT agent_id FROM agents WHERE team=? AND name=? AND role=?`
    ).get(args.team, args.name, args.role) as { agent_id: string } | undefined
  }

  register(input: RegisterInput): { agent_id: string; team: string } {
    const team = input.team ?? 'default'
    const role = input.role ?? 'default'
    const name = input.name
    const existing = this.findByIdentity({ team, name, role })
    const agent_id = existing?.agent_id ?? randomUUID()
    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO agents (agent_id, team, role, name, model, registered_at, last_seen_at, tmux_pane_id)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(agent_id) DO UPDATE SET
         team=excluded.team,
         role=excluded.role,
         name=excluded.name,
         model=excluded.model,
         last_seen_at=excluded.last_seen_at,
         tmux_pane_id=COALESCE(excluded.tmux_pane_id, agents.tmux_pane_id)`
    ).run(agent_id, team, role, name, input.model, now, now, input.tmux_pane_id ?? null)
    return { agent_id, team }
  }

  list(args: { team: string }): AgentListRow[] {
    const rows = this.db.prepare(
      `SELECT agent_id, role, name, model, tmux_pane_id, last_seen_at FROM agents WHERE team=? ORDER BY registered_at ASC`
    ).all(args.team) as Array<{ agent_id: string; role: string; name: string; model: string | null; tmux_pane_id: string | null; last_seen_at: string }>
    const nowMs = Date.now()
    return rows.map(r => ({ ...r, online: nowMs - new Date(r.last_seen_at).getTime() < ONLINE_MS }))
  }

  touch(agent_id: string): void {
    this.db.prepare(`UPDATE agents SET last_seen_at=? WHERE agent_id=?`).run(new Date().toISOString(), agent_id)
  }

  findById(agent_id: string): { agent_id: string; team: string } | undefined {
    return this.db.prepare(`SELECT agent_id, team FROM agents WHERE agent_id=?`).get(agent_id) as
      | { agent_id: string; team: string } | undefined
  }
}
