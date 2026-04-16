import type Database from 'better-sqlite3'
import { AgentsRepo } from '../storage/agents-repo.js'

export interface RegisterInput {
  agent_id: string
  connection_id: string
  model: string
  role: string
  display_name?: string
  team?: string
}

export type RegisterResult =
  | { agent_id: string; team: string }
  | { error: 'agent_id_collision' }

export class RegisterAgentService {
  private readonly repo: AgentsRepo
  private readonly connections = new Map<string, string>()

  constructor(db: Database.Database) { this.repo = new AgentsRepo(db) }

  register(input: RegisterInput): RegisterResult {
    const bound = this.connections.get(input.agent_id)
    if (bound && bound !== input.connection_id) return { error: 'agent_id_collision' }
    this.connections.set(input.agent_id, input.connection_id)
    return this.repo.register(input)
  }

  releaseConnection(agent_id: string, connection_id: string): void {
    if (this.connections.get(agent_id) === connection_id) this.connections.delete(agent_id)
  }
}
