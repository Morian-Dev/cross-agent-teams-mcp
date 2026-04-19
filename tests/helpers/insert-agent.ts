import type Database from 'better-sqlite3'

export interface InsertAgentArgs {
  agent_id: string
  model?: string
  role?: string
  name?: string
  team?: string
  tmux_pane_id?: string | null
  registered_at?: string
  last_seen_at?: string
}

// Test helper: insert a row directly into `agents` with an explicit agent_id.
// Prefer this over AgentsRepo.register when tests need deterministic IDs.
export function insertAgent(db: Database.Database, args: InsertAgentArgs): string {
  const now = new Date().toISOString()
  const team = args.team ?? 'default'
  const role = args.role ?? 'default'
  const name = args.name ?? args.agent_id
  const model = args.model ?? 'test-model'
  const registered_at = args.registered_at ?? now
  const last_seen_at = args.last_seen_at ?? now
  const tmux_pane_id = args.tmux_pane_id ?? null
  db.prepare(
    `INSERT INTO agents (agent_id, team, role, name, model, registered_at, last_seen_at, tmux_pane_id)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(agent_id) DO UPDATE SET
       team=excluded.team, role=excluded.role, name=excluded.name, model=excluded.model,
       last_seen_at=excluded.last_seen_at, tmux_pane_id=excluded.tmux_pane_id`
  ).run(args.agent_id, team, role, name, model, registered_at, last_seen_at, tmux_pane_id)
  return args.agent_id
}
