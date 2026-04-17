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

export async function poke(deps: PokeDeps, _input: PokeInput): Promise<PokeResult> {
  if (!deps.callerAgentId) return { error: 'unknown_agent' }
  return { error: 'unknown_target' }
}
