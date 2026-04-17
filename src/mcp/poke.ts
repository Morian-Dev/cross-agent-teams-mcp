import type Database from 'better-sqlite3'

export interface PokeDeps {
  db: Database.Database
  callerAgentId: string | null
}

export interface PokeInput {
  target_agent_id: string
  prompt: string
}

export type PokeResult =
  | { ok: true; pane_id: string; pane_tail_before: string; pane_tail_after: string }
  | { error: string; detail?: unknown }

interface TargetRow {
  agent_id: string
  team: string
  tmux_pane_id: string | null
}

export async function poke(deps: PokeDeps, input: PokeInput): Promise<PokeResult> {
  if (!deps.callerAgentId) return { error: 'unknown_agent' }

  const target = deps.db
    .prepare(`SELECT agent_id, team, tmux_pane_id FROM agents WHERE agent_id = ?`)
    .get(input.target_agent_id) as TargetRow | undefined
  if (!target) return { error: 'unknown_target' }

  if (target.agent_id === deps.callerAgentId) return { error: 'self_poke_denied' }

  if (!target.tmux_pane_id) return { error: 'tmux_pane_not_set' }

  return { error: 'tmux_cmd_failed' }
}
