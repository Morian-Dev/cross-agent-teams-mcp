import type Database from 'better-sqlite3'

export interface RegisterInput {
  agent_id: string
  model: string
  role: string
  display_name?: string
  team?: string
  tmux_pane_id?: string
}

export interface AgentListRow {
  agent_id: string
  role: string
  display_name: string | null
  model: string | null
  tmux_pane_id: string | null
  last_seen_at: string
  online: boolean
}

const ONLINE_MS = 5 * 60 * 1000

export class AgentsRepo {
  constructor(private db: Database.Database) {}

  register(input: RegisterInput): { agent_id: string; team: string } {
    const team = input.team ?? 'default'
    const now = new Date().toISOString()
    this.db.prepare(
      `INSERT INTO agents (agent_id, team, role, display_name, model, registered_at, last_seen_at, tmux_pane_id)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(agent_id) DO UPDATE SET
         team=excluded.team,
         role=excluded.role,
         display_name=excluded.display_name,
         model=excluded.model,
         last_seen_at=excluded.last_seen_at,
         tmux_pane_id=COALESCE(excluded.tmux_pane_id, agents.tmux_pane_id)`
    ).run(input.agent_id, team, input.role, input.display_name ?? null, input.model, now, now, input.tmux_pane_id ?? null)
    return { agent_id: input.agent_id, team }
  }

  list(args: { team: string }): AgentListRow[] {
    const rows = this.db.prepare(
      `SELECT agent_id, role, display_name, model, tmux_pane_id, last_seen_at FROM agents WHERE team=? ORDER BY registered_at ASC`
    ).all(args.team) as Array<{ agent_id: string; role: string; display_name: string | null; model: string | null; tmux_pane_id: string | null; last_seen_at: string }>
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
