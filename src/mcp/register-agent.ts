import type Database from 'better-sqlite3'
import { AgentsRepo } from '../storage/agents-repo.js'

export interface RegisterInput {
  connection_id: string
  model: string
  name: string
  role?: string
  team?: string
  tmux_pane_id?: string
  channel_session_id?: string
}

export type RegisterResult =
  | { agent_id: string; team: string }
  | { error: 'agent_id_collision' }

function identityKey(team: string, name: string): string {
  return `${team}\u0000${name}`
}

export class RegisterAgentService {
  private readonly repo: AgentsRepo
  private readonly connections = new Map<string, string>()

  constructor(db: Database.Database) { this.repo = new AgentsRepo(db) }

  register(input: RegisterInput): RegisterResult {
    const team = input.team ?? 'default'
    const role = input.role ?? 'default'
    const key = identityKey(team, input.name)
    const bound = this.connections.get(key)
    if (bound && bound !== input.connection_id) return { error: 'agent_id_collision' }
    this.connections.set(key, input.connection_id)
    return this.repo.register({
      model: input.model,
      name: input.name,
      role,
      team,
      tmux_pane_id: input.tmux_pane_id,
      channel_session_id: input.channel_session_id
    })
  }

  releaseConnection(agent_id: string, connection_id: string): void {
    // Release by connection_id — scan and unbind any identity key mapped to this connection.
    for (const [k, cid] of this.connections) {
      if (cid === connection_id) this.connections.delete(k)
    }
    void agent_id
  }
}
